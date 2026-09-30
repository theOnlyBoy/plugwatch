/**
 * @file config.ts — load, default, validate `config.json`
 * ======================================================
 * All tunables live in `config.json` (git-ignored; see `config.example.json`).
 * Nothing is hardcoded: model ids, binaries and paths are config, not code.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ActiveHours, Config, DelayConfig, Mode, Target } from './types.ts'

/** Package root — the directory holding `package.json` (`src/`'s or `dist/`'s parent). */
export const packageRoot = path.resolve(import.meta.dirname, '..')

/**
 * Whether this is a source checkout rather than an installed package. A
 * published package ships only `dist/`, so the presence of `src/` is the tell.
 */
export const isCheckout = fs.existsSync(path.join(packageRoot, 'src'))

/**
 * Directory holding config, logs, runtime state and the built notification helper.
 *
 * - `PLUGWATCH_HOME` always wins (tests, multi-profile setups).
 * - A source checkout keeps everything in the repo, so the dev workflow is
 *   unchanged.
 * - An installed package must not write inside `node_modules`, so it uses the
 *   user's application-support directory.
 */
export const dataDir =
	process.env.PLUGWATCH_HOME ??
	(isCheckout ? packageRoot : path.join(os.homedir(), 'Library', 'Application Support', 'plugwatch'))

/** The CLI entry the LaunchAgent and `start` should run for this installation. */
export const entryPath = isCheckout
	? path.join(packageRoot, 'src', 'main.ts')
	: path.join(packageRoot, 'dist', 'main.js')

/** Runtime scratch dir: PID file, log, persisted state. */
export const runDir = path.join(dataDir, 'run')

/** Default path of the config file (`config.json` in {@link dataDir}). */
export const defaultConfigPath = path.join(dataDir, 'config.json')

/** Built-in defaults, overridden by anything present in `config.json`. */
export const DEFAULTS = {
	mode: 'ask' as Mode,
	pollSec: 60,
	notifications: { system: true },
	delay: { acSec: 120, batterySec: 60 } satisfies DelayConfig,
} as const

/**
 * Resolve which config file to load. `PLUGWATCH_CONFIG` (absolute path)
 * overrides the default — used by tests and multi-profile setups.
 *
 * @returns Absolute path to the config file.
 */
export function configPath(): string {
	return process.env.PLUGWATCH_CONFIG ?? defaultConfigPath
}

/**
 * Copy the shipped `config.example.json` into {@link dataDir} as `config.json`.
 *
 * Installed packages have no checkout to copy from, so this is how a new user
 * gets a starting config.
 *
 * @param overwrite - Replace an existing `config.json` when true.
 * @returns The path written, or the existing path when nothing was done.
 * @throws If the example is missing (should not happen in a published package).
 */
export function writeDefaultConfig(overwrite = false): { path: string; created: boolean } {
	const target = defaultConfigPath
	if (fs.existsSync(target) && !overwrite) return { path: target, created: false }

	const example = path.join(packageRoot, 'config.example.json')
	if (!fs.existsSync(example)) throw new Error(`config.example.json not found at ${example}`)

	fs.mkdirSync(dataDir, { recursive: true })
	fs.copyFileSync(example, target)
	return { path: target, created: true }
}

function fail(message: string): never {
	throw new Error(`invalid config: ${message}`)
}

/**
 * Expand a leading `~` to the user's home directory, so configs stay portable
 * across machines (never hardcode a username).
 *
 * @param value - A path that may start with `~` or `~/`.
 * @returns The path with `~` expanded.
 */
export function expandHome(value: string): string {
	if (value === '~') return os.homedir()
	if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
	return value
}

/**
 * Validate a single target entry. Throws with a precise message on the first
 * problem so a bad config fails loudly at startup rather than mid-transition.
 *
 * @param raw - The parsed target object.
 * @param index - Position in `targets`, used in error messages.
 * @returns The validated target.
 */
function validateTarget(raw: unknown, index: number): Target {
	const where = `targets[${index}]`
	if (typeof raw !== 'object' || raw === null) fail(`${where} must be an object`)
	const t = raw as Record<string, unknown>
	if (typeof t.id !== 'string' || t.id.length === 0) fail(`${where}.id must be a non-empty string`)

	const commands = (value: unknown, field: 'start' | 'stop'): string[][] => {
		if (!Array.isArray(value)) fail(`${where}.${field} must be an array of [cmd, ...args]`)
		return value.map((entry, i) => {
			if (!Array.isArray(entry) || entry.length === 0 || !entry.every((a) => typeof a === 'string')) {
				fail(`${where}.${field}[${i}] must be a non-empty array of strings`)
			}
			return entry as string[]
		})
	}

	return {
		id: t.id,
		label: typeof t.label === 'string' ? t.label : undefined,
		bin: typeof t.bin === 'string' ? expandHome(t.bin) : undefined,
		start: commands(t.start, 'start'),
		stop: commands(t.stop, 'stop'),
		detached: t.detached === true,
		env: isStringRecord(t.env) ? t.env : undefined,
		timeoutMs: typeof t.timeoutMs === 'number' ? t.timeoutMs : undefined,
		enabled: t.enabled !== false,
	}
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === 'object' &&
		value !== null &&
		Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string')
	)
}

/**
 * Validate `mode`. Unknown values fail loudly rather than silently falling back
 * to the default, so a typo doesn't quietly change how the service behaves.
 *
 * @param raw - The raw config value.
 * @returns The validated mode (`ask` when omitted).
 */
function validateMode(raw: unknown): Mode {
	if (raw === undefined) return DEFAULTS.mode
	if (raw === 'ask' || raw === 'auto') return raw
	fail(`mode must be "ask" or "auto" (got ${JSON.stringify(raw)})`)
}

function validateActiveHours(raw: unknown): ActiveHours | undefined {
	if (raw === undefined) return undefined
	if (typeof raw !== 'object' || raw === null) fail('activeHours must be an object')
	const { start, end } = raw as Record<string, unknown>
	if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || start > 23 || end < 0 || end > 23) {
		fail('activeHours.start and .end must be hours 0–23')
	}
	return { start, end }
}

/**
 * Load, default, and validate the config file.
 *
 * @param file - Config path to read (defaults to {@link configPath}).
 * @returns The fully-resolved config.
 * @throws If the file is missing, unparseable, or fails validation.
 */
export function loadConfig(file: string = configPath()): Config {
	if (!fs.existsSync(file)) {
		throw new Error(`config not found: ${file}\nRun \`plugwatch init\` to write a starter config.`)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
	} catch (e) {
		throw new Error(`config is not valid JSON (${file}): ${(e as Error).message}`)
	}
	if (typeof parsed !== 'object' || parsed === null) fail('top level must be an object')
	const raw = parsed as Record<string, unknown>

	const targetsRaw = raw.targets
	if (!Array.isArray(targetsRaw) || targetsRaw.length === 0) fail('targets must be a non-empty array')
	const targets = targetsRaw.map(validateTarget)

	const ids = new Set(targets.map((t) => t.id))
	if (ids.size !== targets.length) fail('target ids must be unique')

	const pollSec = typeof raw.pollSec === 'number' && raw.pollSec > 0 ? raw.pollSec : DEFAULTS.pollSec

	const notificationsRaw = (raw.notifications ?? {}) as Record<string, unknown>
	const notifications = {
		system: notificationsRaw.system !== false,
	}

	const delayRaw = (raw.delay ?? {}) as Record<string, unknown>
	const delay: DelayConfig = {
		acSec: typeof delayRaw.acSec === 'number' && delayRaw.acSec >= 0 ? delayRaw.acSec : DEFAULTS.delay.acSec,
		batterySec:
			typeof delayRaw.batterySec === 'number' && delayRaw.batterySec >= 0
				? delayRaw.batterySec
				: DEFAULTS.delay.batterySec,
	}

	return {
		mode: validateMode(raw.mode),
		pollSec,
		notifications,
		delay,
		activeHours: validateActiveHours(raw.activeHours),
		configFile: file,
		dataDir,
		targets,
	}
}

/**
 * Whether `now` falls inside the configured active-hours window. With no
 * window configured, always `true`. Handles windows that wrap past midnight
 * (e.g. `start: 22, end: 6`).
 *
 * @param hours - The window, or `undefined` to disable the restriction.
 * @param now - The timestamp to test (defaults to now).
 * @returns `true` if auto-start is allowed at this time.
 */
export function withinActiveHours(hours: ActiveHours | undefined, now: Date = new Date()): boolean {
	if (!hours) return true
	const h = now.getHours()
	return hours.start <= hours.end ? h >= hours.start && h < hours.end : h >= hours.start || h < hours.end
}
