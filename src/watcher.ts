/**
 * @file watcher.ts — poll power, apply hysteresis, ask, act
 * ========================================================
 * The heart of the service. One loop:
 *   1. poll power every `pollSec`;
 *   2. when the state changes, hold it for `delay.*Sec` (hysteresis) — a brief
 *      unplug/re-plug cancels the pending transition;
 *   3. if it holds, ask the user via an actionable notification and, on confirm,
 *      run the targets. Every stable transition asks — whether the apps are
 *      running cannot be known for certain, so the service never assumes.
 *
 * The state machine is a pure function ({@link hysteresisStep}) so it can be
 * unit-tested without timers or hardware.
 */

import { withinActiveHours } from './config.ts'
import { log } from './log.ts'
import { clearNotifications, notifyInfo, prompt, promptPending, type NotifyAction } from './notify.ts'
import { readPower } from './power.ts'
import { runTargets } from './targets.ts'
import type { Config, PowerState, Target, TargetResult } from './types.ts'

/** Options controlling a watcher run. */
export interface WatcherOptions {
	/** Pretend the machine is always this power state (test without unplugging). */
	simulate?: PowerState
	/** Skip the notification and assume the user said yes (scripted testing). */
	noNotify?: boolean
}

/** Pure hysteresis state: last observed state and the pending candidate. */
export interface HysteresisState {
	/** Last observed power state (may be `null` before a successful read). */
	current: PowerState | null
	/** Power state being timed; cleared if it does not hold for the delay. */
	candidate: PowerState | null
	/** When `candidate` started (ms epoch). */
	candidateSince: number
}

/** Result of one hysteresis step: the new state, and the state that settled. */
export interface HysteresisStep {
	state: HysteresisState
	/** The candidate that just held for its full delay, if any. */
	settled: PowerState | null
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function enabledTargets(config: Config): Target[] {
	return config.targets.filter((t) => t.enabled !== false)
}

function label(targets: Target[]): string {
	return targets.map((t) => t.label ?? t.id).join(', ')
}

/**
 * macOS renders at most four body lines, and truncates each around 40
 * characters. Trimming here instead means the cut is ours and predictable.
 */
const MAX_BODY_LINES = 4
/**
 * Label budget. Deliberately well under the ~40 characters macOS allows: glyphs
 * vary in width, so a nominally 40-character line can still overflow and be cut
 * mid-word by the system. 30 is comfortably inside it.
 */
const MAX_LABEL_CHARS = 30

/**
 * Shorten an over-long label, marking the cut with an ellipsis.
 *
 * @param text - The label.
 * @param max - Maximum characters to keep.
 * @returns The label, truncated if needed.
 */
export function truncateLabel(text: string, max: number = MAX_LABEL_CHARS): string {
	if (text.length <= max) return text
	return text.slice(0, max - 1).trimEnd() + '…'
}

/**
 * Notification body: a bulleted list capped at the lines macOS actually shows.
 * Bullets are used even for a single target — the list reads as a list
 * regardless of how many entries it holds. Extras collapse into an "…and N
 * more" line rather than being silently cut off, and each label is trimmed so
 * the ellipsis lands where we choose it.
 *
 * @param targets - The affected targets.
 * @returns Newline-separated bullets, at most {@link MAX_BODY_LINES} lines.
 */
export function bodyList(targets: Target[]): string {
	const names = targets.map((t) => t.label ?? t.id)

	// Four targets fit exactly and are all shown; only a fifth forces the summary,
	// which then takes the fourth line.
	const overflow = names.length > MAX_BODY_LINES
	const shown = names.slice(0, overflow ? MAX_BODY_LINES - 1 : MAX_BODY_LINES)
	const lines = shown.map((name) => '• ' + truncateLabel(name))
	if (overflow) lines.push('…and ' + (names.length - shown.length) + ' more')
	return lines.join('\n')
}

function delayMsFor(config: Config, state: PowerState): number {
	return (state === 'ac' ? config.delay.acSec : config.delay.batterySec) * 1000
}

/**
 * Notification title: the power status, in one shape for every prompt.
 *
 * There is no startup/transition split — an earlier `Mac is on …` variant for
 * startup and wake was dropped so every notification reads identically.
 *
 * @param state - The power state, or `null` when it could not be read.
 * @returns e.g. `Mac → AC power`, `Mac → battery power`, `Power status`.
 */
export function notificationTitle(state: PowerState | null): string {
	if (state === null) return 'Power status'
	const status = state === 'ac' ? 'AC power' : 'battery power'
	return 'Mac → ' + status
}

/**
 * Label for the single confirmation button.
 *
 * @param action - What confirming will do.
 * @returns `Confirm launch` for start, `Stop` for stop.
 */
export function buttonTitle(action: 'start' | 'stop'): string {
	return action === 'start' ? 'Confirm launch' : 'Stop'
}

/**
 * Whether a transition should ask the user rather than being applied silently.
 *
 * Three ways to end up silent: `mode: auto` (a deliberate choice), notifications
 * switched off at the system level, or `--no-notify` for a single run. `mode`
 * and `notifications.system` are independent on purpose — one decides *whether to
 * ask*, the other *whether to show anything at all*.
 *
 * @param config - Resolved config.
 * @param opts - Watcher options.
 * @returns `true` when a prompt should be posted.
 */
function shouldAsk(config: Config, opts: WatcherOptions): boolean {
	return config.mode === 'ask' && config.notifications.system && !opts.noNotify
}

/**
 * Advance the hysteresis state machine by one poll.
 *
 * - `observed === null` (read failure) is ignored entirely.
 * - A change starts (or restarts) a candidate timer and never acts immediately.
 * - Once the candidate has held for its delay it "settles" and is reported in
 *   `settled`. There is deliberately no "already in the desired state" check:
 *   whether the targets are running is not knowable for certain, so the watcher
 *   asks rather than assuming.
 *
 * @param state - Current state.
 * @param observed - Latest power reading (`null` = failed read).
 * @param now - Current time, ms epoch.
 * @param delayMs - Delay for a given target state, ms.
 * @returns The next state and the state that settled (if any).
 */
export function hysteresisStep(
	state: HysteresisState,
	observed: PowerState | null,
	now: number,
	delayMs: (state: PowerState) => number,
): HysteresisStep {
	if (observed === null) return { state, settled: null }

	if (observed !== state.current) {
		return {
			state: { ...state, current: observed, candidate: observed, candidateSince: now },
			settled: null,
		}
	}

	if (state.candidate !== null && now - state.candidateSince >= delayMs(state.candidate)) {
		return { state: { ...state, candidate: null }, settled: state.candidate }
	}

	return { state, settled: null }
}

/**
 * Whether a finished decision should re-arm the hysteresis hold.
 *
 * Only when power genuinely moved **while the prompt was open** — then the new
 * state deserves its own delay instead of being lost. Re-arming on every
 * answered prompt would ask again and again about the same unchanged state:
 * one transition, one question.
 *
 * @param current - Power state at the moment the decision finished.
 * @param settled - The state the decision was about.
 * @returns `true` when the hold should restart for `current`.
 */
export function shouldRearmAfterDecision(current: PowerState | null, settled: PowerState): boolean {
	return current !== null && current !== settled
}

/**
 * Ask the user and, on confirmation, run the targets for this transition.
 *
 * @param config - Resolved config.
 * @param next - The power state we have settled on.
 * @param opts - Watcher options (notification bypass).
 * @returns The target results, or `null` if nothing ran.
 */
/** Which direction a manual control (or transition) applies to the targets. */
type TargetAction = 'start' | 'stop'

/**
 * A loop gap beyond `pollSec` + this slack means the process was suspended
 * (system sleep) rather than merely polling slowly.
 */
const WAKE_GAP_SLACK_MS = 15_000

/**
 * Only re-offer the controls after a sleep at least this long. Closing the lid
 * for a moment should not produce another notification.
 */
const WAKE_CONTROL_MIN_GAP_MS = 5 * 60_000

/**
 * Run one action for every enabled target and log the outcome.
 *
 * @param config - Resolved config.
 * @param action - `start` or `stop`.
 * @returns Per-target results, or `null` when nothing is enabled.
 */
async function applyTargets(config: Config, action: TargetAction): Promise<TargetResult[] | null> {
	const targets = enabledTargets(config)
	if (targets.length === 0) {
		log('no enabled targets — nothing to do')
		return null
	}

	log(`${action} ${label(targets)} …`)
	const results = await runTargets(targets, action)
	for (const result of results) {
		log(`  ${result.id}: ${result.ok ? 'ok' : 'FAILED'}`)
	}
	return results
}

/**
 * Ask the user about a settled transition and, on confirmation, run the targets.
 *
 * @param config - Resolved config.
 * @param next - The power state we have settled on.
 * @param opts - Watcher options (notification bypass).
 * @returns The target results, or `null` if nothing ran.
 */
async function handleTransition(
	config: Config,
	next: PowerState,
	opts: WatcherOptions,
): Promise<TargetResult[] | null> {
	const targets = enabledTargets(config)
	if (targets.length === 0) {
		log('no enabled targets — nothing to do')
		return null
	}

	const action: 'start' | 'stop' = next === 'ac' ? 'start' : 'stop'

	if (action === 'start' && !withinActiveHours(config.activeHours)) {
		log('outside active hours — not starting')
		return null
	}

	// A single affirmative button. Declining is just closing the notification, so a
	// Skip/Keep button would only duplicate the ✕ — and a one-button prompt can
	// never be mis-clicked into the opposite action. Worded without "app": a target
	// is whatever its commands start (a server, a daemon, a database), not
	// necessarily a GUI application.
	const actions: NotifyAction[] = [{ id: action, title: buttonTitle(action) }]
	const names = label(targets)

	if (!shouldAsk(config, opts)) {
		const reason = config.mode === 'auto' ? 'mode: auto' : 'notifications off'
		log(`acting without asking (${reason}) — ${action} ${names}`)
	} else {
		// A power transition outranks the startup controls. Withdraw whatever is
		// on screen and stop waiting on it, otherwise this prompt would queue
		// behind a prompt nobody answered and only appear after it times out.
		if (promptPending()) {
			log('withdrawing the pending prompt — a power transition needs an answer')
			clearNotifications()
		}

		// Title describes the power change, the body lists the affected apps one per
		// line, and the single button says what it will do.
		const outcome = await prompt(notificationTitle(next), bodyList(targets), actions)
		if (outcome.kind !== 'action') {
			log(`no confirmation (${outcome.kind}) — skipping ${action}`)
			return null
		}
	}

	return applyTargets(config, action)
}

/**
 * Run the watcher loop forever (until the process is killed).
 *
 * @param config - Resolved config.
 * @param opts - Watcher options.
 */
export async function runWatcher(config: Config, opts: WatcherOptions = {}): Promise<never> {
	const initial = opts.simulate ?? readPower()
	if (initial === null) {
		log('could not read power state at startup — will retry each poll')
	}

	// Hysteresis state lives in plain locals so an in-flight decision cannot
	// clobber the loop's own updates to `current` / `candidate`. Declared before
	// the shutdown handler, which reports the state it stopped in.
	//
	// Note what is deliberately absent: any notion of "the power state the targets
	// are configured for". Whether an app is running cannot be known for certain,
	// so the watcher asks on every stable transition instead of assuming — an
	// assumed state that happens to be wrong silently suppresses the prompt the
	// user needed.
	let current = initial
	let candidate: PowerState | null = null
	let candidateSince = 0
	/** True while a prompt and its resulting action are in flight. */
	let deciding = false

	// Lifecycle notices are informational and fired immediately — they are not
	// gated by the power-transition hysteresis delays.
	const lifecycle = (title: string, body: string) => {
		if (opts.noNotify || !config.notifications.system) return
		notifyInfo(title, body)
	}

	const shutdown = () => {
		// Withdraw anything still on screen (e.g. an unanswered control prompt),
		// then announce the stop so nothing is left clickable but inert.
		clearNotifications()
		lifecycle('plugwatch', 'Service stopped')
		// Give the detached poster a moment to exec before we exit.
		setTimeout(() => process.exit(0), 400)
	}
	process.once('SIGTERM', shutdown)
	process.once('SIGINT', shutdown)

	const names = label(enabledTargets(config))
	log(`watcher started (poll ${config.pollSec}s, power ${initial ?? 'unknown'}, targets: ${names || 'none'})`)

	// Drop notifications left by a previous run before posting new ones — their
	// buttons belong to a watcher that no longer exists and would do nothing.
	clearNotifications()

	/**
	 * Ask about a settled transition and act — deliberately **not** awaited by the
	 * loop. Awaiting it stalled power monitoring for as long as the prompt stayed
	 * unanswered, so transitions during that window were never even detected.
	 *
	 * Decisions are token-guarded so a newer state can supersede an open prompt:
	 * the superseded decision then ignores its own (cancelled) result instead of
	 * clearing the newer decision's `deciding` flag.
	 *
	 * @param settled - The power state whose delay elapsed.
	 */
	let decisionToken = 0

	const decide = (settled: PowerState) => {
		const token = ++decisionToken
		deciding = true
		void handleTransition(config, settled, opts)
			.then(() => {
				if (token !== decisionToken) return // superseded by a newer state
				// Re-arm **only** for a genuine move while we were asking. Re-arming on
				// any answered prompt would ask again and again about the same state.
				if (shouldRearmAfterDecision(current, settled)) {
					log(`power moved to ${current} while deciding ${settled} — re-arming the hold`)
					candidate = current
					candidateSince = Date.now()
				}
			})
			.finally(() => {
				if (token === decisionToken) deciding = false
			})
	}

	// Coming up asks the same question the current power state implies — same
	// copy, same single button as a transition prompt. Fire-and-forget: the poll
	// loop must keep watching power while the user decides.
	if (shouldAsk(config, opts) && initial !== null) decide(initial)

	let lastTick = Date.now()

	for (;;) {
		await sleep(config.pollSec * 1000)

		const now = Date.now()
		const gap = now - lastTick
		lastTick = now

		// A long gap means the machine slept. Timers were suspended, so anything
		// we were holding could not be watched — restart the hold, and re-offer
		// the controls when the machine was away long enough to matter.
		if (gap > config.pollSec * 1000 + WAKE_GAP_SLACK_MS) {
			log(`resumed after a ${Math.round(gap / 1000)}s gap (system sleep) — re-evaluating`)
			candidate = null
			if (gap >= WAKE_CONTROL_MIN_GAP_MS && shouldAsk(config, opts) && current !== null) {
				decide(current)
			}
		}

		const observed = opts.simulate ?? readPower()
		if (observed === null) {
			log('power read failed — keeping last known state')
			continue
		}

		const before = current
		const step = hysteresisStep({ current, candidate, candidateSince }, observed, now, (s) => delayMsFor(config, s))
		current = step.state.current
		candidate = step.state.candidate
		candidateSince = step.state.candidateSince

		if (current !== before && current !== null) {
			const secs = delayMsFor(config, current) / 1000
			log(`power → ${current}; acting after ${secs}s if it holds`)
		}

		if (step.settled !== null) {
			if (deciding) {
				// The open prompt asked about a state we have since left, so it is
				// stale. Supersede it rather than skipping this one: prompts have no
				// timeout, so waiting for the user would block every future prompt.
				log(`power → ${step.settled} settled — superseding the open prompt`)
			}
			decide(step.settled)
		}
	}
}

/**
 * Evaluate the current power state once and act immediately (no hysteresis).
 * Used by `--once`.
 *
 * @param config - Resolved config.
 * @param opts - Watcher options.
 * @returns The target results, or `null` if nothing ran.
 */
export async function runOnce(config: Config, opts: WatcherOptions = {}): Promise<TargetResult[] | null> {
	const observed = opts.simulate ?? readPower()
	if (observed === null) {
		log('power read failed — nothing to do')
		return null
	}
	log(`power: ${observed}`)
	return handleTransition(config, observed, opts)
}
