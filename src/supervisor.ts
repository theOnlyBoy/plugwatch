/**
 * @file supervisor.ts — start/stop/restart/logs for the watcher process
 * ====================================================================
 * Owns the daemon lifecycle that used to live in the `plugwatch` bash wrapper:
 * a detached child in its own session, a PID file, and liveness checks that do
 * not rely on the shell.
 *
 * Detaching matters: `spawn(..., { detached: true })` makes the child a session
 * leader, so signals aimed at the invoking shell's process group (a package
 * manager exiting, a terminal closing, Ctrl-C) cannot kill the watcher.
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { entryPath, runDir } from './config.ts'

/** PID file for the detached watcher. */
export const pidFile = path.join(runDir, 'plugwatch.pid')
/** Log file the watcher's stdout/stderr are appended to. */
export const logFile = path.join(runDir, 'plugwatch.log')

/** How long to give the watcher to either come up or shut down, ms. */
const GRACE_MS = 10_000

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Whether a PID currently exists. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/**
 * Live watcher PIDs.
 *
 * The PID file alone is not enough: it can be stale, and a watcher started by
 * hand (`node src/main.ts`) was never written to it. `ps` catches both, matching
 * on the absolute entry path so unrelated processes cannot collide.
 *
 * @returns Live PIDs, de-duplicated.
 */
export function watcherPids(): number[] {
	const pids = new Set<number>()

	try {
		const recorded = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
		if (Number.isInteger(recorded) && recorded > 0) pids.add(recorded)
	} catch {
		// No PID file — fine.
	}

	try {
		const out = execFileSync('ps', ['ax', '-o', 'pid=', '-o', 'command='], { encoding: 'utf8', timeout: 5000 })
		for (const line of out.split('\n')) {
			const match = line.match(/^\s*(\d+)\s+(.*)$/)
			if (!match) continue
			const [, pid, command] = match
			if (pid && command && command.includes(entryPath)) pids.add(Number.parseInt(pid, 10))
		}
	} catch {
		// `ps` unavailable — fall back to the PID file alone.
	}

	return [...pids].filter(alive)
}

/** Wait until no watcher is left, or the grace period expires. */
async function waitForExit(): Promise<void> {
	const deadline = Date.now() + GRACE_MS
	while (Date.now() < deadline && watcherPids().length > 0) {
		await sleep(250)
	}
}

/** Last few log lines, for surfacing a failed start. */
function logTail(lines = 5): string {
	try {
		return fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
	} catch {
		return '(no log yet)'
	}
}

/**
 * Start the watcher in the background unless one is already running.
 *
 * @returns Process exit code (0 ok, 1 failed to start).
 */
/**
 * Whether a foreground start must be refused because another watcher is running.
 *
 * Two watchers do not merely coexist: every prompt runs `PlugNotify --clear`,
 * which withdraws *every* delivered notification for the bundle, so each
 * instance deletes the other's prompt. Hence the refusal by default.
 *
 * @param others - Other live watcher PIDs (excluding this process).
 * @param opts.force - `--force` was passed: the user means it.
 * @param opts.managed - The process was spawned by the supervisor or launchd,
 *   both of which already checked; blocking them would make launchd's
 *   `KeepAlive` restart the agent in a loop.
 * @returns `true` when the foreground start should abort.
 */
export function shouldRefuseDuplicate(others: number[], opts: { force: boolean; managed: boolean }): boolean {
	return others.length > 0 && !opts.force && !opts.managed
}

export async function startWatcher(): Promise<number> {
	const running = watcherPids()
	if (running.length > 0) {
		console.log(`plugwatch is already running (pid ${running.join(',')}) — nothing to do`)
		return 0
	}

	fs.mkdirSync(runDir, { recursive: true })
	const out = fs.openSync(logFile, 'a')
	// detached => new session; unref => the parent can exit immediately.
	// PLUGWATCH_MANAGED tells the child's duplicate-instance guard that we already
	// checked for a running watcher, so it should not refuse to be its own.
	const child = spawn(process.execPath, [entryPath], {
		detached: true,
		stdio: ['ignore', out, out],
		env: { ...process.env, PLUGWATCH_MANAGED: '1' },
	})
	child.unref()
	fs.writeFileSync(pidFile, String(child.pid))
	fs.closeSync(out)

	// Give it time to get past node startup and config load — reporting success
	// on a process that dies a moment later is worse than a short wait.
	await sleep(1500)
	if (child.pid && alive(child.pid)) {
		console.log(`plugwatch started (pid ${child.pid}) — log: ${logFile}`)
		return 0
	}

	fs.rmSync(pidFile, { force: true })
	console.error('plugwatch failed to start — last log lines:')
	console.error(logTail())
	return 1
}

/**
 * Stop every running watcher.
 *
 * @returns Process exit code (0 ok, 1 if something refused to die).
 */
export async function stopWatcher(): Promise<number> {
	const running = watcherPids()
	if (running.length === 0) {
		fs.rmSync(pidFile, { force: true })
		console.log('plugwatch is already stopped')
		return 0
	}

	for (const pid of running) {
		try {
			process.kill(pid, 'SIGTERM')
		} catch {
			// Already gone.
		}
	}
	await waitForExit()
	fs.rmSync(pidFile, { force: true })

	const left = watcherPids()
	if (left.length > 0) {
		console.error(`plugwatch: still shutting down (pids: ${left.join(',')})`)
		return 1
	}
	console.log(`plugwatch stopped (pid ${running.join(',')})`)
	return 0
}

/** Stop then start. */
export async function restartWatcher(): Promise<number> {
	await stopWatcher()
	return startWatcher()
}

/** Follow the watcher log (blocks until interrupted). */
export function followLog(): Promise<number> {
	fs.mkdirSync(runDir, { recursive: true })
	fs.closeSync(fs.openSync(logFile, 'a'))
	return new Promise((resolve) => {
		const child = spawn('tail', ['-f', logFile], { stdio: 'inherit' })
		child.on('close', (code) => resolve(code ?? 0))
		child.on('error', (error: Error) => {
			console.error(`plugwatch: could not tail ${logFile}: ${error.message}`)
			resolve(1)
		})
	})
}

/** Human-readable summary of the running state, for `status`. */
export function describeRunning(agentInstalled: boolean): string {
	const pids = watcherPids()
	if (pids.length > 0) return `plugwatch: RUNNING (pid ${pids.join(',')}${agentInstalled ? ', LaunchAgent' : ''})`
	if (agentInstalled) return 'plugwatch: LaunchAgent installed but NOT running (start to resume)'
	return 'plugwatch: not running'
}
