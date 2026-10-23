/**
 * Step 68.4 CLI gate: function boundaries and source module mode survive the compiled entrypoint.
 *
 * The scanner unit tests cover the lexical decisions directly. These cases also run the built CLI
 * in a child process so analyzer wiring, output channels and exit codes remain covered together.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILT_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function runProject(
  manifest: Record<string, unknown>,
  files: Readonly<Record<string, string>>,
): RunResult {
  const project = mkdtempSync(join(tmpdir(), 'depvitals-step68-4-cli-'));

  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify(manifest));

    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(project, name), source);
    }

    const result = spawnSync(process.execPath, [BUILT_ENTRY, project], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEPVITALS_NO_UPDATE_CHECK: '1',
      },
    });

    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

describe('Step 68.4 compiled CLI gate', () => {
  it('reports a nested ordinary function require as missing', () => {
    const result = runProject(
      { name: 'nested-function', version: '0.0.0' },
      {
        'index.cjs': `
          async function outer() {
            function inner(await) {
              return await / require('real') / 2;
            }
          }
        `,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('DepVitals\n\nMissing dependencies (1)\n  real\n');
    expect(result.stderr).toBe('');
  });

  it('does not report regex text from top-level await in an mjs module', () => {
    const result = runProject(
      { name: 'top-level-module', version: '0.0.0' },
      { 'index.mjs': `await /require('fake')/;` },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('DepVitals\n\nNo dependency issues found.\n');
    expect(result.stderr).toBe('');
  });
});
