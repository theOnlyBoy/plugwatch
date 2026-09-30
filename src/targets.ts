/**
 * @file targets.ts — run a target's ordered start/stop command lists
 * ==================================================================
 * Commands are argv arrays (`[cmd, ...args]`) executed in order.
 *
 * `start` is **fail-fast** — a broken `server start` must not cascade into a
 * failing `load`. `stop` is **best-effort** — every step runs even if an earlier
 * one complains, because leaving a server running after a partial stop means it
 * can silently reload the very model we were asked to release.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from './log.ts'
import type { CommandFailure, Target, TargetResult } from './types.ts'

/** Generous default for start commands — `lms load` on a large model is slow. */
const START_TIMEOUT_MS = 180_000
/** Stop commands should be quick (`unload`, `pkill`). */
const STOP_TIMEOUT_MS = 60_000

/** Well-known CLI locations, tried when a bare command name isn't on PATH. */
const KNOWN_BINS: Record<string, string[]> = {
	lms: [path.join(os.homedir(), '.cache/lm-studio/bin/lms')],
	ollama: ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama'],
}

function firstExecutable(candidates: string[]): string | null {
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK)
			return candidate
		} catch {
			// try the next candidate
		}
	}
	return null
}

/**
 * Resolve a command's executable.
 *
 * - If the target's `bin` basename matches `cmd[0]`, `bin` wins (e.g. a target
 *   with `bin: "/Users/…/lms"` rewrites `["lms", "server", "start"]`).
 * - Otherwise a bare name is looked up in {@link KNOWN_BINS}, then left to PATH.
 *
 * @param cmd - The argv array from config.
 * @param target - The owning target (for `bin`).
 * @returns The executable and its arguments.
 */
export function resolveCommand(cmd: string[], target: Target): { exe: string; args: string[] } {
	const name = cmd[0]
	if (!name) throw new Error(`empty command for target ${target.id}`)

	let exe = name
	if (target.bin && path.basename(target.bin) === name) {
		exe = target.bin
	} else if (!name.includes('/')) {
		const known = KNOWN_BINS[name]
		if (known) exe = firstExecutable(known) ?? name
	}
	return { exe, args: cmd.slice(1) }
}

interface RunOptions {
	detached: boolean
	timeoutMs: number
	env: NodeJS.ProcessEnv
}

/**
 * Run a single command. Detached commands are fire-and-forget (resolve once
 * spawned); otherwise resolves after exit or timeout-kill.
 *
 * @returns A {@link CommandFailure}, or `null` on success.
 */
function runCommand(exe: string, args: string[], opts: RunOptions): Promise<CommandFailure | null> {
	return new Promise((resolve) => {
		const child = spawn(exe, args, {
			detached: opts.detached,
			stdio: opts.detached ? 'ignore' : ['ignore', 'ignore', 'pipe'],
			env: opts.env,
		})

		if (opts.detached) {
			child.unref()
			resolve(null)
			return
		}

		let stderr = ''
		const stderrStream = child.stderr
		stderrStream?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString()
		})

		const timer = setTimeout(() => {
			child.kill('SIGKILL')
			resolve({ cmd: [exe, ...args], code: null, error: `timed out after ${opts.timeoutMs}ms` })
		}, opts.timeoutMs)

		child.on('error', (error) => {
			clearTimeout(timer)
			resolve({ cmd: [exe, ...args], code: null, error: error.message })
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			resolve(code === 0 ? null : { cmd: [exe, ...args], code, error: stderr.trim() || undefined })
		})
	})
}

/**
 * Execute one target's start or stop sequence, fail-fast.
 *
 * @param target - The target to act on.
 * @param action - Which sequence (`start` or `stop`) to run.
 * @returns The per-target result (never throws).
 */
export async function runTarget(target: Target, action: 'start' | 'stop'): Promise<TargetResult> {
	const commands = action === 'start' ? target.start : target.stop
	const detached = action === 'start' && target.detached === true
	const env = { ...process.env, ...target.env }
	const timeoutMs = target.timeoutMs ?? (action === 'start' ? START_TIMEOUT_MS : STOP_TIMEOUT_MS)

	const failures: CommandFailure[] = []
	const failFast = action === 'start'
	let detachedCount = 0

	for (const cmd of commands) {
		const { exe, args } = resolveCommand(cmd, target)
		log(`  ${target.id}: ${action} $ ${exe} ${args.join(' ')}`)
		const failure = await runCommand(exe, args, { detached, timeoutMs, env })
		if (failure) {
			failures.push(failure)
			log(`  ${target.id}: ${action} FAILED (${failure.error ?? `exit ${failure.code}`})`)
			if (failFast) break
		}
		if (detached) detachedCount++
	}

	return { id: target.id, action, ok: failures.length === 0, failures, detached: detachedCount }
}

/**
 * Run the given targets' start/stop sequences in order.
 *
 * @param targets - Targets to act on.
 * @param action - Which sequence to run.
 * @returns One result per target.
 */
export async function runTargets(targets: Target[], action: 'start' | 'stop'): Promise<TargetResult[]> {
	const results: TargetResult[] = []
	for (const target of targets) {
		results.push(await runTarget(target, action))
	}
	return results
}
