/**
 * @file log.ts — timestamped logging
 * =================================
 * Writes to stdout only. Persistence is owned by whatever launched the process:
 * launchd's `StandardOutPath`, or the supervisor's redirect into `run/plugwatch.log`.
 * Appending to that same file here as well would double every line.
 */

/** Local-time timestamp, no milliseconds: `2026-09-30 18:53:01`. */
export function ts(): string {
	const d = new Date()
	const p = (n: number) => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Log a line to stdout with a timestamp prefix.
 *
 * @param message - The message to log.
 */
export function log(message: string): void {
	console.log(`${ts()} ${message}`)
}
