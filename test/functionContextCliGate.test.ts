/**
 * Function boundaries, async signatures and source module mode survive the compiled entrypoint.
 *
 * The scanner unit tests cover the lexical decisions directly. These cases also run the built CLI
 * in a child process so analyzer wiring, output channels and exit codes remain covered together.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyzeProject } from '../src/core/analyzeProject.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILT_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function runBuilt(project: string): RunResult {
  const result = spawnSync(process.execPath, [BUILT_ENTRY, project], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DEPVITALS_NO_UPDATE_CHECK: '1',
    },
  });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

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

    return runBuilt(project);
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
      { 'index.mjs': `await /require('fake')/; require('real');` },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('DepVitals\n\nMissing dependencies (1)\n  real\n');
    expect(result.stderr).toBe('');
  });
});

describe('Step 68.6 async boundaries through analyzer and compiled CLI', () => {
  const cases = [
    {
      name: 'A: newline before an ordinary block arrow',
      source: `async\nx => { return await / require('real') / 2; };`,
      dependency: 'real',
      isUsage: true,
    },
    {
      name: 'B: multiline async expression arrow parameters',
      source: `const f = async (\n value\n) => await /require('fake')/;`,
      dependency: 'fake',
      isUsage: false,
    },
    {
      name: 'C: async function expression followed by division',
      source: `const n = async function () {} / require('real') / 2;`,
      dependency: 'real',
      isUsage: true,
    },
  ];

  for (const declared of [false, true]) {
    it.each(cases)('$name with declared=' + String(declared), async (scenario) => {
      const project = mkdtempSync(join(tmpdir(), 'depvitals-step68-6-'));
      const manifest = JSON.stringify({
        name: 'async-boundaries',
        version: '0.0.0',
        ...(declared ? { dependencies: { [scenario.dependency]: '*' } } : {}),
      });

      try {
        writeFileSync(join(project, 'package.json'), manifest);
        writeFileSync(join(project, 'index.cjs'), scenario.source);

        const missing = scenario.isUsage && !declared ? [scenario.dependency] : [];
        const unused = !scenario.isUsage && declared ? [scenario.dependency] : [];
        const expected = {
          projectRoot: project,
          unusedDependencies: unused,
          unusedDevDependencies: [],
          missingDependencies: missing,
        };

        expect(await analyzeProject(project)).toEqual(expected);
        expect(await analyzeProject(project)).toEqual(expected);
        expect(runBuilt(project)).toEqual({
          status: missing.length + unused.length > 0 ? 1 : 0,
          stdout:
            missing.length > 0
              ? 'DepVitals\n\nMissing dependencies (1)\n  real\n'
              : unused.length > 0
                ? 'DepVitals\n\nUnused dependencies (1)\n  fake\n'
                : 'DepVitals\n\nNo dependency issues found.\n',
          stderr: '',
        });
        expect(readdirSync(project).sort()).toEqual(['index.cjs', 'package.json']);
        expect(readFileSync(join(project, 'package.json'), 'utf8')).toBe(manifest);
        expect(readFileSync(join(project, 'index.cjs'), 'utf8')).toBe(scenario.source);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });
  }
});
