import { describe, expect, it } from 'vitest'
import { shouldRefuseDuplicate } from '../src/supervisor.ts'

describe('shouldRefuseDuplicate', () => {
	it('refuses a second watcher started by hand', () => {
		expect(shouldRefuseDuplicate([1234], { force: false, managed: false })).toBe(true)
	})

	it('allows it when no watcher is running', () => {
		expect(shouldRefuseDuplicate([], { force: false, managed: false })).toBe(false)
	})

	it('honours --force', () => {
		expect(shouldRefuseDuplicate([1234], { force: true, managed: false })).toBe(false)
	})

	it('never blocks a supervisor- or launchd-owned child', () => {
		// Blocking these would make launchd's KeepAlive restart the agent in a loop.
		expect(shouldRefuseDuplicate([1234], { force: false, managed: true })).toBe(false)
	})
})
