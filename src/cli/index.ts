#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { runCli } from './runCli.js';

/**
 * Thin executable adapter for the `v0.1.0` CLI.
 *
 * Its only responsibilities are:
 * 1. resolve the package version from the single source of truth (`package.json`);
 * 2. collect `process.argv`, `process.cwd()` and the version;
 * 3. await the pure orchestration in `runCli`;
 * 4. render the returned stdout/stderr;
 * 5. assign `process.exitCode` (never call `process.exit()`).
 *
 * All argument handling, scanning orchestration and error mapping live in `runCli`, so this file
 * only wires process I/O to that orchestration. The relative path works both from the TypeScript
 * source (`src/cli/index.ts`) and from the built output (`dist/cli/index.js`), because both resolve
 * to the repository root `package.json`.
 */
const version = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

const result = await runCli(process.argv.slice(2), {
  version: version.version,
  cwd: process.cwd(),
});

if (result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}

if (result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}

process.exitCode = result.exitCode;
