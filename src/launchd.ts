/**
 * @file launchd.ts — install/uninstall the LaunchAgent
 * ====================================================
 * Renders `service/com.plugwatch.agent.plist` with absolute paths (launchd
 * expands neither `~` nor `$HOME`) into `~/Library/LaunchAgents/` and manages it
 * with `launchctl`.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataDir, entryPath, packageRoot } from './config.ts'
import { log } from './log.ts'
import { helperAvailable } from './notify.ts'
import { logFile } from './supervisor.ts'

/** launchd job label; also the plist filename stem. */
export const LABEL = 'com.plugwatch.agent'

const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
/** Where the rendered agent lives. */
export const plistPath = path.join(launchAgentsDir, `${LABEL}.plist`)
/** The shipped template (lives in the package, not the data dir). */
const templatePath = path.join(packageRoot, 'service', `${LABEL}.plist`)
/** Helper build script, also shipped with the package. */
const buildScript = path.join(packageRoot, 'scripts', 'build-notify.sh')

/** Whether the LaunchAgent plist is present. */
export function agentInstalled(): boolean {
	return fs.existsSync(plistPath)
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
	try {
		const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
		return { ok: true, out }
	} catch (e) {
		const err = e as { stderr?: string; message: string }
		return { ok: false, out: (err.stderr ?? err.message).toString() }
	}
}

/** The launchd domain target for the current user, e.g. `gui/501`. */
function domain(): string {
	const uid = typeof process.getuid === 'function' ? process.getuid() : 0
	return `gui/${uid}`
}

/**
 * Render the plist template with real absolute paths.
 *
 * @returns The plist XML to write.
 */
export function renderPlist(): string {
	const template = fs.readFileSync(templatePath, 'utf8')
	return template
		.replaceAll('__NODE__', process.execPath)
		.replaceAll('__ENTRY__', entryPath)
		.replaceAll('__LOG__', logFile)
}

/**
 * Build the notification helper if it is missing, then install and start the
 * LaunchAgent. Idempotent: an existing agent is booted out first.
 */
export function installAgent(): void {
	if (!helperAvailable()) {
		log('helper missing — building PlugNotify.app')
		const build = run('bash', [buildScript, dataDir])
		if (!build.ok) log(`build:notify failed: ${build.out.trim()}`)
	}

	fs.mkdirSync(launchAgentsDir, { recursive: true })
	fs.mkdirSync(dataDir, { recursive: true })
	if (!fs.existsSync(path.join(dataDir, 'config.json'))) {
		log(`no config yet — copy config.example.json to ${path.join(dataDir, 'config.json')} and edit it`)
	}
	fs.writeFileSync(plistPath, renderPlist())
	log(`wrote ${plistPath}`)

	run('launchctl', ['bootout', domain(), plistPath]) // ignore: may not be loaded
	const result = run('launchctl', ['bootstrap', domain(), plistPath])
	if (!result.ok) {
		log(`bootstrap failed (${result.out.trim()}) — trying legacy load`)
		const legacy = run('launchctl', ['load', '-w', plistPath])
		if (!legacy.ok) throw new Error(`could not load LaunchAgent: ${legacy.out.trim()}`)
	}
	run('launchctl', ['kickstart', '-k', `${domain()}/${LABEL}`])
	log(`installed and started ${LABEL}`)
}

/**
 * Stop and remove the LaunchAgent. Optionally purge config + runtime state.
 *
 * @param purge - When true, also delete `config.json` and `run/`.
 */
export function uninstallAgent(purge: boolean): void {
	if (agentInstalled()) {
		const result = run('launchctl', ['bootout', domain(), plistPath])
		if (!result.ok) log(`bootout: ${result.out.trim()}`)
		fs.rmSync(plistPath, { force: true })
		log(`removed ${plistPath}`)
	} else {
		log('LaunchAgent is not installed')
	}

	if (purge) {
		fs.rmSync(path.join(dataDir, 'config.json'), { force: true })
		fs.rmSync(path.join(dataDir, 'run'), { recursive: true, force: true })
		log(`purged config.json and run/ from ${dataDir}`)
	}
}
