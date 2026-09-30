import { describe, expect, it } from 'vitest'
import { bodyList, buttonTitle, notificationTitle, runOnce, truncateLabel } from '../src/watcher.ts'
import type { Config, Target } from '../src/types.ts'

function app(label: string): Target {
	return { id: label, label, start: [], stop: [] }
}

describe('truncateLabel', () => {
	it('leaves a short label alone', () => {
		expect(truncateLabel('LM Studio')).toBe('LM Studio')
	})

	it('trims a long label with a single-char ellipsis, within budget', () => {
		const out = truncateLabel('X'.repeat(80))
		expect(out).toHaveLength(30)
		expect(out.endsWith('…')).toBe(true)
	})

	it('does not leave a trailing space before the ellipsis', () => {
		expect(truncateLabel('abcde fghij', 7)).toBe('abcde…')
	})
})

// These pin the user-visible copy to what README/power-state.md document, so a
// wording change has to be made deliberately in both places.
describe('notification copy', () => {
	it('titles a transition by direction', () => {
		expect(notificationTitle('ac', 'transition')).toBe('Mac -> AC power')
		expect(notificationTitle('battery', 'transition')).toBe('Mac -> battery power')
	})

	it('titles a startup without claiming a switch happened', () => {
		expect(notificationTitle('ac', 'startup')).toBe('Mac is on AC power')
		expect(notificationTitle('battery', 'startup')).toBe('Mac is on battery power')
	})

	it('falls back to a neutral title when power could not be read', () => {
		expect(notificationTitle(null, 'transition')).toBe('Power status')
	})

	it('uses one button, worded for the action', () => {
		expect(buttonTitle('start')).toBe('Confirm launch')
		expect(buttonTitle('stop')).toBe('Stop')
	})
})

describe('bodyList', () => {
	it('bullets a single target too', () => {
		expect(bodyList([app('Alpha')])).toBe('• Alpha')
	})

	it('puts one app per line', () => {
		expect(bodyList([app('Alpha'), app('Beta')])).toBe('• Alpha\n• Beta')
	})

	it('keeps every line comfortably within what macOS renders', () => {
		const single = bodyList([app('Y'.repeat(90))])
		expect(single).toHaveLength(32) // "• " + 30
		expect(single.endsWith('…')).toBe(true)

		const firstLine = bodyList([app('Y'.repeat(90)), app('Z')]).split('\n')[0]
		expect(firstLine).toHaveLength(32)
	})

	it('collapses extras only past the fourth app', () => {
		const lines = bodyList(['a', 'b', 'c', 'd', 'e', 'f'].map(app)).split('\n')
		expect(lines).toHaveLength(4)
		expect(lines.slice(0, 3)).toEqual(['• a', '• b', '• c'])
		expect(lines[3]).toBe('…and 3 more')
	})

	it('shows all four when there are exactly four', () => {
		const lines = bodyList(['a', 'b', 'c', 'd'].map(app)).split('\n')
		expect(lines).toEqual(['• a', '• b', '• c', '• d'])
	})
})

function config(overrides: Partial<Config> = {}): Config {
	return {
		mode: 'ask',
		pollSec: 1,
		notifications: { system: false },
		delay: { acSec: 0, batterySec: 0 },
		configFile: '/tmp/plugwatch-test.json',
		dataDir: '/tmp',
		targets: [],
		...overrides,
	}
}

function echoTarget(overrides: Partial<Target> = {}): Target {
	return { id: 'echo', start: [['/bin/echo', 'up']], stop: [['/bin/echo', 'down']], ...overrides }
}

describe('runOnce', () => {
	it('does nothing when there are no enabled targets', async () => {
		const result = await runOnce(config({ targets: [] }), { simulate: 'ac', noNotify: true })
		expect(result).toBeNull()
	})

	it('runs the start sequence on simulated AC', async () => {
		const result = await runOnce(config({ targets: [echoTarget()] }), { simulate: 'ac', noNotify: true })
		expect(result?.[0]?.action).toBe('start')
		expect(result?.[0]?.ok).toBe(true)
	})

	it('runs the stop sequence on simulated battery', async () => {
		const result = await runOnce(config({ targets: [echoTarget()] }), { simulate: 'battery', noNotify: true })
		expect(result?.[0]?.action).toBe('stop')
		expect(result?.[0]?.ok).toBe(true)
	})

	it('skips auto-start outside active hours', async () => {
		// A window of 0..0 never contains any hour.
		const result = await runOnce(config({ targets: [echoTarget()], activeHours: { start: 0, end: 0 } }), {
			simulate: 'ac',
			noNotify: true,
		})
		expect(result).toBeNull()
	})

	it('acts silently in auto mode, without prompting', async () => {
		// mode: auto + notifications on must not prompt — if it did, this test would
		// hang (or post a real notification) instead of returning.
		const result = await runOnce(config({ mode: 'auto', notifications: { system: true }, targets: [echoTarget()] }), {
			simulate: 'ac',
		})
		expect(result?.[0]?.action).toBe('start')
		expect(result?.[0]?.ok).toBe(true)
	})

	it('ignores disabled targets', async () => {
		const result = await runOnce(config({ targets: [echoTarget({ enabled: false })] }), {
			simulate: 'ac',
			noNotify: true,
		})
		expect(result).toBeNull()
	})
})
