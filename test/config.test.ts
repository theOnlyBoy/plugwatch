import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULTS, loadConfig, withinActiveHours } from '../src/config.ts'

const tmpFiles: string[] = []

function writeConfig(contents: unknown): string {
	const file = path.join(os.tmpdir(), `plugwatch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
	fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents))
	tmpFiles.push(file)
	return file
}

afterEach(() => {
	for (const file of tmpFiles.splice(0)) fs.rmSync(file, { force: true })
})

const MINIMAL = { targets: [{ id: 't', start: [['echo', 'hi']], stop: [['echo', 'bye']] }] }

describe('loadConfig', () => {
	it('defaults to asking', () => {
		expect(loadConfig(writeConfig(MINIMAL)).mode).toBe('ask')
	})

	it('accepts mode: auto', () => {
		expect(loadConfig(writeConfig({ ...MINIMAL, mode: 'auto' })).mode).toBe('auto')
	})

	it('rejects an unknown mode rather than silently defaulting', () => {
		expect(() => loadConfig(writeConfig({ ...MINIMAL, mode: 'sometimes' }))).toThrow(/mode must be/)
	})

	it('applies defaults when sections are omitted', () => {
		const cfg = loadConfig(writeConfig(MINIMAL))
		expect(cfg.pollSec).toBe(DEFAULTS.pollSec)
		expect(cfg.delay.acSec).toBe(DEFAULTS.delay.acSec)
		expect(cfg.delay.batterySec).toBe(DEFAULTS.delay.batterySec)
		expect(cfg.notifications.system).toBe(true)
		expect(cfg.activeHours).toBeUndefined()
	})

	it('lets config override defaults', () => {
		const cfg = loadConfig(
			writeConfig({
				...MINIMAL,
				pollSec: 15,
				notifications: { system: false },
				delay: { acSec: 5, batterySec: 1 },
				activeHours: { start: 8, end: 20 },
			}),
		)
		expect(cfg.pollSec).toBe(15)
		expect(cfg.notifications.system).toBe(false)
		expect(cfg.delay).toEqual({ acSec: 5, batterySec: 1 })
		expect(cfg.activeHours).toEqual({ start: 8, end: 20 })
	})

	it('defaults label to the target id implicitly and enabled to true', () => {
		const cfg = loadConfig(writeConfig(MINIMAL))
		expect(cfg.targets[0]?.id).toBe('t')
		expect(cfg.targets[0]?.enabled).toBe(true)
	})

	it('throws when the file is missing', () => {
		expect(() => loadConfig('/nonexistent/plugwatch/config.json')).toThrow(/config not found/)
	})

	it('throws on non-JSON content', () => {
		expect(() => loadConfig(writeConfig('{ not json'))).toThrow(/not valid JSON/)
	})

	it('throws when targets is missing or empty', () => {
		expect(() => loadConfig(writeConfig({}))).toThrow(/targets must be a non-empty array/)
		expect(() => loadConfig(writeConfig({ targets: [] }))).toThrow(/targets must be a non-empty array/)
	})

	it('throws on duplicate target ids', () => {
		const dup = { targets: [MINIMAL.targets[0], MINIMAL.targets[0]] }
		expect(() => loadConfig(writeConfig(dup))).toThrow(/unique/)
	})

	it('throws on a malformed command entry', () => {
		const bad = { targets: [{ id: 'x', start: ['not-an-array'], stop: [] }] }
		expect(() => loadConfig(writeConfig(bad))).toThrow(/non-empty array of strings/)
	})
})

describe('withinActiveHours', () => {
	const at = (hour: number) => new Date(2026, 0, 1, hour, 0, 0)

	it('is always true without a window', () => {
		expect(withinActiveHours(undefined, at(3))).toBe(true)
	})

	it('handles a plain window', () => {
		const hours = { start: 7, end: 23 }
		expect(withinActiveHours(hours, at(6))).toBe(false)
		expect(withinActiveHours(hours, at(7))).toBe(true)
		expect(withinActiveHours(hours, at(22))).toBe(true)
		expect(withinActiveHours(hours, at(23))).toBe(false)
	})

	it('handles a window that wraps past midnight', () => {
		const hours = { start: 22, end: 6 }
		expect(withinActiveHours(hours, at(23))).toBe(true)
		expect(withinActiveHours(hours, at(2))).toBe(true)
		expect(withinActiveHours(hours, at(12))).toBe(false)
	})
})
