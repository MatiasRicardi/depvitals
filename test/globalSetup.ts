/**
 * Shared build preparation for the process-level CLI gates (Step 68.3).
 *
 * Some tests run the CLI exactly as users do: as `dist/cli/index.js` in a real child process.
 * Those tests must never depend on an artifact left by an earlier command. Timestamps cannot prove
 * that every emitted file came from the current source tree: configuration changes, deleted source
 * files, partial output and manually adjusted mtimes can all make a stale build look current.
 *
 * Vitest runs this setup once, in the main process, before any worker collects a file. The build is
 * therefore unconditional and starts from an empty `dist/`, making the resulting module graph an
 * exact product of the current source and TypeScript configuration. The setup also registers the
 * same operation through Vitest's rerun hook, which is awaited before watch-mode tests run again.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TestProject } from 'vitest/node';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST_DIRECTORY = join(REPO_ROOT, 'dist');
const BUILT_ENTRY = join(DIST_DIRECTORY, 'cli', 'index.js');
const TSC = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** Recreate the complete CLI build used by process-level tests. */
export function buildCliForProcessGates(): void {
  rmSync(DIST_DIRECTORY, { recursive: true, force: true });

  const build = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  if (build.status !== 0 || !existsSync(BUILT_ENTRY)) {
    throw new Error(
      [
        'Could not prepare dist/ for the process-level CLI gates.',
        `tsc exit status: ${String(build.status)}`,
        `expected entry: ${BUILT_ENTRY}`,
        'Run `pnpm run build` and re-run the tests.',
        `${build.stderr}${build.stdout}`.trim().slice(0, 1000),
      ].join('\n'),
    );
  }
}

/** Build before the initial collection and before every watch-mode rerun. */
export function setup(project: TestProject): void {
  buildCliForProcessGates();
  project.onTestsRerun(() => {
    buildCliForProcessGates();
  });
}
