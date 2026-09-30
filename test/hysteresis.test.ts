import { describe, expect, it } from 'vitest'
import { hysteresisStep, shouldRearmAfterDecision, type HysteresisState } from '../src/watcher.ts'
import type { PowerState } from '../src/types.ts'

const DELAY: Record<PowerState, number> = { ac: 1000, battery: 500 }
const delayMs = (s: PowerState) => DELAY[s]

function state(overrides: Partial<HysteresisState> = {}): HysteresisState {
	return { current: 'battery', candidate: null, candidateSince: 0, ...overrides }
}

describe('shouldRearmAfterDecision', () => {
	it('does not re-arm when power has not moved — an answered prompt must not loop', () => {
		expect(shouldRearmAfterDecision('ac', 'ac')).toBe(false)
		expect(shouldRearmAfterDecision('battery', 'battery')).toBe(false)
	})

	it('re-arms when power moved while the prompt was open', () => {
		expect(shouldRearmAfterDecision('battery', 'ac')).toBe(true)
	})

	it('does not re-arm when power is unknown', () => {
		expect(shouldRearmAfterDecision(null, 'ac')).toBe(false)
	})
})

describe('hysteresisStep', () => {
	it('ignores a failed read', () => {
		const before = state()
		const step = hysteresisStep(before, null, 10_000, delayMs)
		expect(step.state).toBe(before)
		expect(step.settled).toBeNull()
	})

	it('starts a candidate timer on change, without settling', () => {
		const step = hysteresisStep(state(), 'ac', 10_000, delayMs)
		expect(step.state.current).toBe('ac')
		expect(step.state.candidate).toBe('ac')
		expect(step.state.candidateSince).toBe(10_000)
		expect(step.settled).toBeNull()
	})

	it('does not settle before the delay elapses', () => {
		const s = state({ current: 'ac', candidate: 'ac', candidateSince: 10_000 })
		const step = hysteresisStep(s, 'ac', 10_500, delayMs)
		expect(step.settled).toBeNull()
		expect(step.state.candidate).toBe('ac')
	})

	it('settles once the candidate holds for the full delay', () => {
		const s = state({ current: 'ac', candidate: 'ac', candidateSince: 10_000 })
		const step = hysteresisStep(s, 'ac', 11_000, delayMs)
		expect(step.settled).toBe('ac')
		expect(step.state.candidate).toBeNull()
	})

	it('settles exactly once per transition — holding the state settles nothing more', () => {
		const first = hysteresisStep(state({ current: 'ac', candidate: 'ac', candidateSince: 0 }), 'ac', 1000, delayMs)
		expect(first.settled).toBe('ac')
		// The candidate is cleared, so subsequent polls of the same state are quiet:
		// no repeat prompt until power actually changes again.
		const second = hysteresisStep(first.state, 'ac', 2000, delayMs)
		expect(second.settled).toBeNull()
	})

	it('uses the per-state delay (battery delay is shorter)', () => {
		const s = state({ current: 'battery', candidate: 'battery', candidateSince: 0 })
		expect(hysteresisStep(s, 'battery', 500, delayMs).settled).toBe('battery')
		const acState = state({ current: 'ac', candidate: 'ac', candidateSince: 0 })
		expect(hysteresisStep(acState, 'ac', 500, delayMs).settled).toBeNull()
	})

	it('cancels a pending transition when the state reverts', () => {
		const s = state({ current: 'ac', candidate: 'ac', candidateSince: 10_000 })
		const step = hysteresisStep(s, 'battery', 10_400, delayMs)
		expect(step.state.current).toBe('battery')
		expect(step.state.candidate).toBe('battery') // new timer for the revert
		expect(step.settled).toBeNull()
	})

	it('a flap within the delay cancels the first transition', () => {
		let s: HysteresisState = { current: 'battery', candidate: null, candidateSince: 0 }
		const plugged = hysteresisStep(s, 'ac', 0, delayMs) // plug in at t=0
		expect(plugged.settled).toBeNull()
		s = plugged.state
		// Unplug before the 1000ms AC delay elapses, so that transition never fires.
		const unplugged = hysteresisStep(s, 'battery', 800, delayMs)
		expect(unplugged.settled).toBeNull()
		// Returning to battery then settles on its own (shorter) delay — a real
		// transition deserves a prompt; only the flap was suppressed.
		expect(hysteresisStep(unplugged.state, 'battery', 1300, delayMs).settled).toBe('battery')
	})
})
