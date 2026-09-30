import { describe, expect, it } from 'vitest'
import { currentPower, parsePmset } from '../src/power.ts'

const AC_SAMPLE = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=22675555)\t100%; charged; 0:00 remaining present: true`

const BATTERY_SAMPLE = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=22675555)\t97%; discharging; 4:09 remaining present: true`

describe('parsePmset', () => {
	it('detects AC power', () => {
		expect(parsePmset(AC_SAMPLE)).toBe('ac')
	})

	it('detects battery power', () => {
		expect(parsePmset(BATTERY_SAMPLE)).toBe('battery')
	})

	it('returns null when the line is missing', () => {
		expect(parsePmset('')).toBeNull()
		expect(parsePmset('something else entirely')).toBeNull()
	})

	it('returns null for an unrecognised source', () => {
		expect(parsePmset("Now drawing from 'UPS Power'")).toBeNull()
	})
})

describe('currentPower', () => {
	it('prefers the simulate override over the reader', () => {
		expect(currentPower(() => 'ac', 'battery')).toBe('battery')
	})

	it('falls back to the reader without a simulate value', () => {
		expect(currentPower(() => 'ac')).toBe('ac')
	})

	it('propagates a null reader result', () => {
		expect(currentPower(() => null)).toBeNull()
	})
})
