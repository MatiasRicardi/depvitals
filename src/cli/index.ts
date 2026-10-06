#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { runCli } from './runCli.js';

/**
 * Thin executable adapter for the `v0.0.1` CLI bootstrap.
 *
 * Its only responsibilities are:
 * 1. resolve the package version from the single source of truth (`package.json`);
 * 2. delegate argument handling to the pure `runCli` function;
 * 3. render the result to stdout/stderr;
 * 4. assign `process.exitCode` (never call `process.exit()`).
 *
 * The relative path works both from the TypeScript source (`src/cli/index.ts`) and from the built
 * output (`dist/cli/index.js`), because both resolve to the repository root `package.json`.
 */
const version = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

const result = runCli(process.argv.slice(2), version.version);

if (result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}

if (result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}

process.exitCode = result.exitCode;
