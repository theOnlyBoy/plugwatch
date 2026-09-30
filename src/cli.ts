/**
 * @file cli.ts — argument dispatch
 * ================================
 * One entry point for everything: the daemon lifecycle (`start`/`stop`/…), the
 * one-shot/status helpers, and LaunchAgent install/uninstall. Kept thin; the
 * logic lives in the modules.
 */

import { bold, cyan, dim, green, red, yellow } from './color.ts'
import { dataDir, isCheckout, loadConfig, withinActiveHours, writeDefaultConfig } from './config.ts'
import { agentInstalled, installAgent, plistPath, uninstallAgent } from './launchd.ts'
import { helperAvailable } from './notify.ts'
import { currentPower, readPower } from './power.ts'
import {
	describeRunning,
	followLog,
	restartWatcher,
	shouldRefuseDuplicate,
	startWatcher,
	stopWatcher,
	watcherPids,
} from './supervisor.ts'
import { runOnce, runWatcher } from './watcher.ts'
import type { PowerState } from './types.ts'

type Command =
	| 'run'
	| 'start'
	| 'stop'
	| 'restart'
	| 'status'
	| 'logs'
	| 'once'
	| 'init'
	| 'install'
	| 'uninstall'
	| 'help'

/** Subcommands accepted as the first argument. */
const VERBS = new Set<Command>(['start', 'stop', 'restart', 'status', 'logs', 'init', 'install', 'uninstall', 'help'])

/** Flag → description rows, rendered into a column-aligned usage block. */
const USAGE_ROWS: Array<[flag: string, description: string]> = [
	['start', 'start the watcher in the background (no-op if already running)'],
	['stop', 'stop every running watcher'],
	['restart', 'stop then start'],
	['status', 'running state, power state, and configured targets'],
	['logs', 'follow the watcher log'],
	['init [--force]', 'write a starter config.json in the data directory'],
	['install', 'build the notification helper and install the LaunchAgent'],
	['uninstall [--purge]', 'remove the LaunchAgent (--purge also wipes config/logs)'],
	['--status', 'same as `status`'],
	['--once', 'evaluate once and act immediately (no hysteresis)'],
	['--simulate ac|battery', 'pretend the machine is on that power source'],
	['--no-notify', 'skip the notification and assume "yes" (testing)'],
	['--force', 'run even if a watcher is already running (also overwrites config on `init`)'],
	['(no argument)', 'run the watcher loop in the foreground (what launchd starts; refuses if one is running)'],
	['-h, --help', 'show this help'],
]

const usageWidth = Math.max(...USAGE_ROWS.map(([flag]) => flag.length))

export const USAGE = [
	'plugwatch — power-gate local apps on AC/battery transitions',
	'',
	'Usage: plugwatch <command> [options]',
	'',
	...USAGE_ROWS.map(([flag, description]) => `  ${flag.padEnd(usageWidth)}  ${description}`),
	'',
].join('\n')

export interface ParsedArgs {
	command: Command
	simulate?: PowerState
	noNotify: boolean
	purge: boolean
	force: boolean
	error?: string
}

/**
 * Parse arguments: an optional leading subcommand, then flags. Unknown flags set
 * `error` rather than exiting, so {@link main} owns usage output and the exit code.
 *
 * @param argv - Arguments after the script name.
 * @returns Parsed arguments.
 */
export function parseArgs(argv: string[]): ParsedArgs {
	const args: ParsedArgs = { command: 'run', noNotify: false, purge: false, force: false }
	const rest = [...argv]

	const first = rest[0]
	if (first !== undefined && VERBS.has(first as Command)) {
		args.command = first as Command
		rest.shift()
	}

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]
		switch (arg) {
			case '--status':
				args.command = 'status'
				break
			case '--once':
				args.command = 'once'
				break
			case '--install':
				args.command = 'install'
				break
			case '--uninstall':
				args.command = 'uninstall'
				break
			case '--no-notify':
				args.noNotify = true
				break
			case '--purge':
				args.purge = true
				break
			case '--force':
				args.force = true
				break
			case '--simulate': {
				const value = rest[++i]
				if (value !== 'ac' && value !== 'battery') {
					args.error = '--simulate requires ac or battery'
					return args
				}
				args.simulate = value
				break
			}
			case '-h':
			case '--help':
				args.command = 'help'
				break
			default:
				args.error = `unknown argument: ${String(arg)}`
				return args
		}
	}
	return args
}

function printStatus(): void {
	const config = loadConfig()
	const power = currentPower(readPower)
	const hours = config.activeHours

	const powerText = power === null ? yellow('unknown') : power === 'ac' ? green('ac') : yellow('battery')
	const helperText = helperAvailable() ? green('helper built') : red('helper MISSING — run `plugwatch install`')
	const hoursText = hours
		? `${hours.start}–${hours.end} ${withinActiveHours(hours) ? green('(inside)') : dim('(outside)')}`
		: dim('always')

	const row = (key: string, value: string) => console.log(`  ${dim(key.padEnd(13))} ${value}`)

	console.log(describeRunning(agentInstalled()))
	console.log(bold('plugwatch status'))
	row('config', config.configFile)
	row(
		'mode',
		config.mode === 'auto'
			? `${yellow('auto')} ${dim('(acts silently, no prompts)')}`
			: `${green('ask')} ${dim('(notifies before acting)')}`,
	)
	row('power', powerText)
	row('poll', `${config.pollSec}s`)
	row('active hours', hoursText)
	row('notifications', config.notifications.system ? `enabled  ${helperText}` : dim('disabled'))
	row('launchagent', agentInstalled() ? `${green('installed')}  ${dim(plistPath)}` : dim('not installed'))
	row('targets', '')
	for (const target of config.targets) {
		const state = target.enabled === false ? dim('disabled') : green('enabled')
		console.log(`    ${dim('•')} ${bold(target.id)}  ${dim(target.label ?? target.id)}  ${state}`)
	}
	if (isCheckout) console.log(`\n  ${dim(cyan('dev'))} ${dim(`checkout mode — data dir ${dataDir}`)}`)
}

/**
 * Entry point. Owns the process exit code.
 *
 * @param argv - Arguments after the script name.
 */
export async function main(argv: string[]): Promise<void> {
	const args = parseArgs(argv)

	if (args.error) {
		console.error(`plugwatch: ${args.error}\n\n${USAGE}`)
		process.exit(2)
	}

	switch (args.command) {
		case 'help':
			console.log(USAGE)
			return
		case 'start':
			process.exitCode = await startWatcher()
			return
		case 'stop':
			process.exitCode = await stopWatcher()
			return
		case 'restart':
			process.exitCode = await restartWatcher()
			return
		case 'logs':
			process.exitCode = await followLog()
			return
		case 'init': {
			const { path, created } = writeDefaultConfig(args.force)
			console.log(created ? `wrote ${path}` : `config already exists at ${path} (use --force to overwrite)`)
			return
		}
		case 'status':
			printStatus()
			return
		case 'install':
			installAgent()
			return
		case 'uninstall':
			uninstallAgent(args.purge)
			return
		case 'once': {
			const config = loadConfig()
			await runOnce(config, { simulate: args.simulate, noNotify: args.noNotify })
			return
		}
		case 'run': {
			const config = loadConfig()
			// The foreground entry is what launchd runs, so it is normally started by
			// someone who already checked for duplicates (supervisor, launchd) and
			// marks itself with PLUGWATCH_MANAGED. Reaching here *without* that marker
			// means a human ran `plugwatch` directly — and two watchers fight: every
			// prompt calls `PlugNotify --clear`, so each one deletes the other's
			// notification. Refuse rather than let them race.
			const others = watcherPids().filter((pid) => pid !== process.pid)
			if (shouldRefuseDuplicate(others, { force: args.force, managed: Boolean(process.env.PLUGWATCH_MANAGED) })) {
				console.error(
					`plugwatch is already running (pid ${others.join(',')}) — \`plugwatch stop\` first, or pass --force to run anyway`,
				)
				process.exit(1)
			}
			await runWatcher(config, { simulate: args.simulate, noNotify: args.noNotify })
			return
		}
	}
}
