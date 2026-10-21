#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { runCliEntry } from './entry.js';

/**
 * Thin executable adapter for the CLI.
 *
 * Its only responsibilities are:
 * 1. resolve the package version from the single source of truth (`package.json`);
 * 2. hand `process.argv`, `process.cwd()`, `process.env` and the two output streams to
 *    `runCliEntry`, which prints the report, then optionally appends the update notice to stderr;
 * 3. assign `process.exitCode` from the returned status (never call `process.exit()`, so the
 *    optional update check is never truncated and can never change the status).
 *
 * All argument handling, scanning orchestration, error mapping and the notifier sequencing live in
 * `runCli`/`runCliEntry`, so this file only wires process objects to them. The relative path works
 * both from the TypeScript source (`src/cli/index.ts`) and from the built output
 * (`dist/cli/index.js`), because both resolve to the repository root `package.json`.
 */
const version = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

process.exitCode = await runCliEntry(process.argv.slice(2), {
  version: version.version,
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
