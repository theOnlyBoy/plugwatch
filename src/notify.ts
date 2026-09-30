/**
 * @file notify.ts — drive the notification helper
 * ==============================================
 * Locates `swift/PlugNotify.swift`'s compiled bundle and turns it into a
 * promise (actionable) or a fire-and-forget post (informational). The helper's
 * exit code / stdout contract is defined in that file:
 *   0 + id on stdout -> an action was chosen
 *   0 (no output)    -> informational notification posted
 *   2                -> timed out
 *   3                -> dismissed without choosing
 *   1                -> setup error (permission denied, bad args)
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './config.ts'
import { log } from './log.ts'

/** One button on a notification. */
export interface NotifyAction {
	id: string
	title: string
}

/** Result of asking the user, or a reason no answer arrived. */
export type PromptOutcome =
	| { kind: 'action'; id: string }
	| { kind: 'dismiss' }
	/** Superseded by a more important prompt (a power transition). */
	| { kind: 'cancelled' }
	| { kind: 'unavailable' }

/**
 * Absolute path to the compiled helper binary.
 *
 * Deliberately a *single* bundle. A second bundle would allow a per-state
 * notification icon, but macOS treats each bundle as a separate app — so it
 * would cost the user a second notification-permission grant. Not worth it.
 */
const HELPER = path.join(dataDir, 'PlugNotify.app', 'Contents', 'MacOS', 'PlugNotify')

/** Whether the helper has been built and is executable. */
export function helperAvailable(): boolean {
	try {
		fs.accessSync(HELPER, fs.constants.X_OK)
		return true
	} catch {
		return false
	}
}

/**
 * Post an informational notification (no buttons) and return immediately.
 *
 * Fire-and-forget: the helper is spawned detached and never awaited, so callers
 * such as the watcher's shutdown handler are not delayed. Never throws.
 *
 * @param title - Notification title.
 * @param body - Notification body text.
 */
export function notifyInfo(title: string, body: string): void {
	if (!helperAvailable()) return
	try {
		const child = spawn(HELPER, [title, body], { stdio: 'ignore', detached: true })
		child.on('error', (error: Error) => log(`notify: info failed: ${error.message}`))
		child.unref()
	} catch (error) {
		log(`notify: info failed: ${(error as Error).message}`)
	}
}

/** Cancels the prompt currently waiting for an answer, if any. */
let activeCancel: (() => void) | null = null

/**
 * Withdraw every notification this app has delivered or scheduled, and stop
 * waiting on the current prompt.
 *
 * Called before posting fresh controls and on shutdown. Without it, a
 * notification from a previous watcher survives a restart: clicking its buttons
 * writes the action to that dead process's stdout, so the click silently does
 * nothing and the user is left thinking the service ignored them. The leftover
 * helper process would also sit there until its own timeout — or, worse, hold
 * the serialised prompt slot of a still-running watcher.
 *
 * Synchronous on purpose — the removal must have landed before the caller posts
 * the replacement (or exits).
 */
export function clearNotifications(): void {
	abortPendingPrompt()
	withdrawNotifications()
}

/**
 * Withdraw every notification this app has delivered or scheduled.
 *
 * `usernoted` tracks delivered notifications per bundle, so this removes an
 * earlier prompt *and* any informational notice. It is how a new prompt replaces
 * the previous one instead of stacking beside it.
 *
 * Synchronous on purpose: the withdrawal must land before the caller posts.
 */
export function withdrawNotifications(): void {
	if (!helperAvailable()) return
	try {
		spawnSync(HELPER, ['--clear'], { stdio: 'ignore', timeout: 3000 })
	} catch (error) {
		log(`notify: clear failed: ${(error as Error).message}`)
	}
}

/**
 * Kill the helper that is waiting for an answer on the current prompt. Its
 * notification is withdrawn separately (see {@link clearNotifications}); this
 * just stops us waiting on a process nobody may ever answer.
 */
export function abortPendingPrompt(): void {
	const cancel = activeCancel
	activeCancel = null
	cancel?.()
}

/** Whether a prompt is currently waiting for an answer. */
export function promptPending(): boolean {
	return activeCancel !== null
}

// Actionable notifications are serialised: two stacked prompts competing for the
// same click are confusing, and the user can only answer one at a time anyway.
let promptQueue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const run = promptQueue.then(task, task)
	promptQueue = run.catch(() => undefined)
	return run
}

function promptOnce(title: string, body: string, actions: NotifyAction[]): Promise<PromptOutcome> {
	return new Promise<PromptOutcome>((resolve) => {
		let settled = false
		let cancelThis: () => void = () => {}
		const done = (outcome: PromptOutcome) => {
			if (settled) return
			settled = true
			if (activeCancel === cancelThis) activeCancel = null
			resolve(outcome)
		}

		// Replace rather than stack: drop anything already on screen (a previous
		// prompt, a lifecycle notice) so the user always sees exactly one.
		withdrawNotifications()

		const args = [title, body, ...actions.map((a) => `${a.id}:${a.title}`)]
		// `const child` (not a widened let) keeps spawn's precise stdio types, so
		// stdout/stderr are known non-null below.
		const child = spawn(HELPER, args, { stdio: ['ignore', 'pipe', 'pipe'] })
		cancelThis = () => {
			try {
				child.kill('SIGKILL')
			} catch {
				// Already gone.
			}
			done({ kind: 'cancelled' })
		}
		activeCancel = cancelThis
		log(`notify: asking "${title}" (waits until answered, dismissed, or superseded)`)

		let stdout = ''
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString()
		})
		child.stderr.on('data', (chunk: Buffer) => {
			log(`notify: ${chunk.toString().trim()}`)
		})
		child.on('error', (error) => {
			log(`notify: spawn failed: ${error.message}`)
			done({ kind: 'unavailable' })
		})
		child.on('close', (code) => {
			const id = stdout.trim()
			if (code === 0 && id) done({ kind: 'action', id })
			else if (code === 3) done({ kind: 'dismiss' })
			else done({ kind: 'unavailable' })
		})
	})
}

/**
 * Post an actionable notification and wait for the user's choice.
 *
 * Never rejects: any failure (missing helper, spawn error, permission denial)
 * resolves to `{ kind: 'unavailable' }` so the caller can degrade gracefully
 * instead of crashing the watcher. Calls are serialised, so at most one prompt
 * is outstanding at a time.
 *
 * There is no timeout: the promise settles when the user answers, dismisses the
 * notification, or a newer prompt supersedes this one.
 *
 * @param title - Notification title.
 * @param body - Notification body text.
 * @param actions - Buttons, left to right (first is usually the confirm action).
 * @returns The outcome; `action` carries the chosen button id.
 */
export function prompt(title: string, body: string, actions: NotifyAction[]): Promise<PromptOutcome> {
	if (!helperAvailable()) {
		log(`notify: helper not found at ${HELPER} — run \`plugwatch install\``)
		return Promise.resolve({ kind: 'unavailable' })
	}
	if (actions.length === 0) {
		throw new Error('prompt requires at least one action')
	}

	return enqueue(() => promptOnce(title, body, actions))
}
