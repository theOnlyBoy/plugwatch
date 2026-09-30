/**
 * @file color.ts — minimal ANSI coloring for CLI output
 * ====================================================
 * Colors are applied only when stdout is a TTY and `NO_COLOR` is unset, so
 * piped or redirected output (logs, launchd, `--status | cat`) stays plain.
 */

const enabled = process.stdout.isTTY && process.env.NO_COLOR === undefined

/**
 * Build a colouriser for an ANSI SGR code.
 *
 * @param code - SGR parameter, e.g. `32` for green.
 * @returns A function that wraps a string, or a pass-through when color is off.
 */
export function paint(code: number): (text: string) => string {
	if (!enabled) return (text) => text
	return (text) => `\u001B[${code}m${text}\u001B[0m`
}

export const bold = paint(1)
export const dim = paint(2)
export const red = paint(31)
export const green = paint(32)
export const yellow = paint(33)
export const cyan = paint(36)
