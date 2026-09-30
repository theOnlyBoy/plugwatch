/**
 * @file types.ts — shared domain types
 * ====================================
 * Plain type declarations for the config, targets, and power state. No runtime
 * code, so this module is safe to import with `import type`.
 */

/** Which power source the machine is currently drawing from. */
export type PowerState = 'ac' | 'battery'

/**
 * One gated application. Start/stop are ordered lists of argv arrays, executed
 * in order; each entry is `[cmd, ...args]`.
 */
export interface Target {
	/** Stable identifier, used in logs and notifications. */
	id: string
	/** Human-friendly name shown in notifications. Defaults to `id`. */
	label?: string
	/**
	 * Absolute path to the target's binary. When set, it replaces the executable
	 * of any command whose `cmd` equals its basename (e.g. `bin: ".../lms"`
	 * rewrites `["lms", ...]`). Commands not matching (e.g. `pkill`) resolve on
	 * PATH as usual.
	 */
	bin?: string
	/** Ordered start commands, each `[cmd, ...args]`. */
	start: string[][]
	/** Ordered stop commands, each `[cmd, ...args]`. */
	stop: string[][]
	/** Spawn start commands detached and don't wait (for long-running daemons). */
	detached?: boolean
	/** Extra env vars merged into each spawned command. */
	env?: Record<string, string>
	/** Per-target override of the command timeout, milliseconds. */
	timeoutMs?: number
	/** Target is eligible for the AC→start flow (default: true). */
	enabled?: boolean
}

/** Hysteresis hold times, seconds, before acting on a power transition. */
export interface DelayConfig {
	/** Seconds AC must hold before prompting to start. */
	acSec: number
	/** Seconds battery must hold before prompting to stop. */
	batterySec: number
}

/** Local-time window; outside it the service never auto-starts. */
export interface ActiveHours {
	/** Inclusive start hour, 0–23. */
	start: number
	/** Exclusive end hour, 0–23. */
	end: number
}

/**
 * How a stable power transition is handled.
 *
 * - `ask` — post an actionable notification and wait for the user (default).
 * - `auto` — act immediately and silently: no prompt, no startup controls.
 */
export type Mode = 'ask' | 'auto'

/** Fully-resolved runtime config (defaults merged, validated). */
export interface Config {
	/** Whether transitions ask the user or are applied silently. */
	mode: Mode
	/** Power poll interval, seconds. */
	pollSec: number
	notifications: {
		/** Post notifications at all. */
		system: boolean
	}
	delay: DelayConfig
	activeHours?: ActiveHours
	/** Absolute path to the config file this was loaded from. */
	configFile: string
	/** Absolute path to the project root (where `run/` and `config.json` live). */
	dataDir: string
	targets: Target[]
}

/** A single failed command within a target's start/stop sequence. */
export interface CommandFailure {
	cmd: string[]
	code: number | null
	error?: string
}

/** Outcome of running one target's start or stop sequence. */
export interface TargetResult {
	id: string
	action: 'start' | 'stop'
	ok: boolean
	failures: CommandFailure[]
	/** Commands skipped because the action was detached (fire-and-forget). */
	detached: number
}
