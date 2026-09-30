import { describe, expect, it } from 'vitest'
import { resolveCommand, runTarget } from '../src/targets.ts'
import type { Target } from '../src/types.ts'

function target(overrides: Partial<Target> = {}): Target {
	return { id: 't', start: [], stop: [], ...overrides }
}

describe('resolveCommand', () => {
	it('runs a command as-is when it has a path separator', () => {
		const { exe, args } = resolveCommand(['/bin/echo', 'hi'], target())
		expect(exe).toBe('/bin/echo')
		expect(args).toEqual(['hi'])
	})

	it('leaves an unknown bare name for PATH resolution', () => {
		const { exe } = resolveCommand(['definitely-not-a-real-binary-xyz'], target())
		expect(exe).toBe('definitely-not-a-real-binary-xyz')
	})

	it('rewrites a command matching the target bin basename', () => {
		const t = target({ bin: '/opt/tools/bin/foo' })
		const { exe, args } = resolveCommand(['foo', 'sub', 'cmd'], t)
		expect(exe).toBe('/opt/tools/bin/foo')
		expect(args).toEqual(['sub', 'cmd'])
	})

	it('does not rewrite a command that does not match the bin basename', () => {
		const t = target({ bin: '/opt/tools/bin/foo' })
		const { exe } = resolveCommand(['pkill', '-f', 'foo'], t)
		expect(exe).toBe('pkill')
	})
})

describe('runTarget', () => {
	it('reports success when all commands exit 0', async () => {
		const result = await runTarget(
			target({
				start: [
					['/bin/echo', 'a'],
					['/bin/echo', 'b'],
				],
			}),
			'start',
		)
		expect(result.ok).toBe(true)
		expect(result.failures).toEqual([])
	})

	it('fail-fasts on the first non-zero command', async () => {
		const result = await runTarget(target({ start: [['/usr/bin/false'], ['/bin/echo', 'never']] }), 'start')
		expect(result.ok).toBe(false)
		expect(result.failures).toHaveLength(1)
		expect(result.failures[0]?.code).toBe(1)
	})

	it('reports a timeout as a failure', async () => {
		const result = await runTarget(target({ start: [['/bin/sleep', '5']], timeoutMs: 100 }), 'start')
		expect(result.ok).toBe(false)
		expect(result.failures[0]?.error).toMatch(/timed out/)
	})

	it('reports a missing executable as a failure', async () => {
		const result = await runTarget(target({ start: [['/nonexistent/binary']] }), 'start')
		expect(result.ok).toBe(false)
		expect(result.failures).toHaveLength(1)
	})
})
