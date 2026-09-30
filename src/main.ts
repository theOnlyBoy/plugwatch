#!/usr/bin/env node
/**
 * @file main.ts — CLI entry point
 * ==============================
 * The `bin` target (published as `dist/main.js`). Keeps no logic: it hands
 * `argv` to `src/cli.ts` and owns the top-level error exit.
 */

import { main } from './cli.ts'

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(`plugwatch: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
})
