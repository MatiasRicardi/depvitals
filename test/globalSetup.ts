/**
 * Shared build preparation for every test worker (Step 68.3).
 *
 * A few gates run the CLI the way users do: as `dist/cli/index.js` in a real child process. Before
 * this file existed, each of them decided on its own whether the artifact was usable - one skipped
 * its cases when `dist/` was missing, another compiled during its own collection - so the set of
 * tests that actually ran depended on which worker started first and on whether the checkout had
 * been built before. A suite whose coverage changes with worker order is not a gate.
 *
 * Vitest runs `globalSetup` once, in the main process, **before** any worker collects a file, which
 * makes it the single place where that decision can be made. It builds with the repository's own
 * TypeScript configuration - no new tool, no second builder - and only when the artifact is missing
 * or older than `src/`, so a checkout that already ran `pnpm run build` pays nothing.
 *
 * A failure here fails the run with an actionable message instead of silently reducing the suite:
 * the process-level cases must never be skipped merely because the artifact was absent.
 *
 * Paths are derived from `import.meta.url` and the compiler is given an explicit `cwd`, so the suite
 * behaves the same when it is started from another working directory.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILT_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');
const TSC = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * Newest modification time inside a directory tree, used as the freshness signal for `dist/`.
 * Unreadable entries are ignored; an empty or missing tree reports 0.
 */
function newestMtime(directory: string): number {
  if (!existsSync(directory)) {
    return 0;
  }

  let newest = 0;

  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const parent = isAbsolute(entry.parentPath)
      ? entry.parentPath
      : join(directory, entry.parentPath);
    const time = statSync(join(parent, entry.name)).mtimeMs;

    if (time > newest) {
      newest = time;
    }
  }

  return newest;
}

/**
 * Build the CLI when `dist/` is absent or stale, and prove the result is usable.
 *
 * "Stale" is decided by comparing the entry point against the newest source file, so a partial or
 * outdated artifact is rebuilt rather than trusted.
 */
export function setup(): void {
  const sourceTime = newestMtime(join(REPO_ROOT, 'src'));
  const isCurrent = existsSync(BUILT_ENTRY) && statSync(BUILT_ENTRY).mtimeMs >= sourceTime;

  if (isCurrent) {
    return;
  }

  const build = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  const rebuiltTime = existsSync(BUILT_ENTRY) ? statSync(BUILT_ENTRY).mtimeMs : 0;

  if (build.status !== 0 || !existsSync(BUILT_ENTRY) || rebuiltTime < sourceTime) {
    throw new Error(
      [
        'Could not prepare dist/ for the process-level CLI gates.',
        `tsc exit status: ${String(build.status)}`,
        `entry mtime: ${String(rebuiltTime)}, newest source mtime: ${String(sourceTime)}`,
        'Run `pnpm run build` and re-run the tests.',
        `${build.stderr}${build.stdout}`.trim().slice(0, 1000),
      ].join('\n'),
    );
  }
}
