/**
 * @file power.ts — detect AC vs battery from `pmset -g batt`
 * ==========================================================
 * Parsing is split from execution so it can be unit-tested without touching
 * real hardware state.
 */

import { execFileSync } from 'node:child_process'
import type { PowerState } from './types.ts'

/** Absolute path to `pmset` (launchd's PATH may not include /usr/bin, but it does). */
const PMSET = '/usr/bin/pmset'

/**
 * Parse the first meaningful line of `pmset -g batt` output.
 *
 * Recognises macOS's `Now drawing from 'AC Power'` / `'Battery Power'` lines.
 *
 * @param output - Raw stdout of `pmset -g batt`.
 * @returns The detected state, or `null` if the output is unrecognised.
 */
export function parsePmset(output: string): PowerState | null {
	const line = output.split('\n').find((l) => l.includes('Now drawing from'))
	if (!line) return null
	if (line.includes('AC Power')) return 'ac'
	if (line.includes('Battery Power')) return 'battery'
	return null
}

/**
 * Read the current power state from `pmset`.
 *
 * @returns The detected state, or `null` if `pmset` failed or printed
 *   something unexpected. Callers keep their last-known state on `null`.
 */
export function readPower(): PowerState | null {
	try {
		const out = execFileSync(PMSET, ['-g', 'batt'], { encoding: 'utf8', timeout: 5000 })
		return parsePmset(out)
	} catch {
		return null
	}
}

/**
 * Resolve the effective power state, honouring a simulation override.
 *
 * @param read - Reader to use (injectable for tests).
 * @param simulate - When set, returned verbatim instead of reading hardware.
 * @returns The effective state, or `null` if detection failed.
 */
export function currentPower(read: () => PowerState | null = readPower, simulate?: PowerState): PowerState | null {
	return simulate ?? read()
}
