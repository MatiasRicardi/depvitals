/**
 * Step 68.2: JSX and regex/division lexer regressions, end to end.
 *
 * The unit matrices live in `test/unit/scanner/moduleSpecifiers.test.ts`; this file proves the same
 * rules through the real pipeline: committed fixture projects, the CLI orchestration (`runCli`) and
 * the packaged entry point, so the JSX extension/content wiring in `analyzeProject` is exercised too.
 *
 * Every scenario is static and offline. No fixture is executed, transpiled or resolved, and the
 * update notifier is disabled deterministically for the process-level assertions, so the only text
 * compared is the scanner's own report.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type CliOptions, runCli } from '../src/cli/runCli.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ANALYSIS_FIXTURES = join(REPO_ROOT, 'test', 'fixtures', 'analysis');

const VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

const OPTIONS: CliOptions = { version: VERSION, cwd: tmpdir() };

/** The packaged CLI entry point, built by the shared Vitest `globalSetup` before any worker runs. */
const BUILT_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');

const CLEAN_REPORT = 'DepVitals\n\nNo dependency issues found.\n';

function fixture(name: string): string {
  return join(ANALYSIS_FIXTURES, name);
}

/** A recursive snapshot of a fixture tree, used to prove a scan never mutates the project. */
function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};

  for (const entry of readdirSync(directory, { recursive: true })) {
    const relative = String(entry).split(/[\\/]/).join('/');
    const absolute = join(directory, relative);

    if (statSync(absolute).isFile()) {
      files[relative] = readFileSync(absolute, 'utf8');
    }
  }

  return files;
}

describe('Step 68.2: JSX projects scan through the CLI', () => {
  it('reports no issue for a TSX/JSX component tree whose react dependency is declared', async () => {
    const result = await runCli([fixture('jsx-react-component')], OPTIONS);

    // `</div>` used to be read as an unterminated regex literal, which aborted the whole scan.
    expect(result).toEqual({ exitCode: 0, stdout: CLEAN_REPORT, stderr: '' });
  });

  it('reports no issue for JSX in .js, .mjs and .cjs files', async () => {
    const result = await runCli([fixture('jsx-javascript-extensions')], OPTIONS);

    expect(result).toEqual({ exitCode: 0, stdout: CLEAN_REPORT, stderr: '' });
  });

  it('reports no issue for inert JSX text, attributes and comments', async () => {
    const result = await runCli([fixture('jsx-inert-text')], OPTIONS);

    // The apostrophe in `don't` is text, and the require/import-looking strings in the markup are
    // text too, so nothing is declared missing and no package is credited as used.
    expect(result).toEqual({ exitCode: 0, stdout: CLEAN_REPORT, stderr: '' });
  });

  it('reports only the package required inside a JSX expression container', async () => {
    const result = await runCli([fixture('jsx-expression-require')], OPTIONS);

    expect(result).toEqual({
      exitCode: 1,
      stdout: 'DepVitals\n\nMissing dependencies (1)\n  real\n',
      stderr: '',
    });
  });

  it('fails with an operational error on lexically incomplete JSX', async () => {
    const result = await runCli([fixture('jsx-incomplete')], OPTIONS);

    // An unterminated element must never degrade into a partial, apparently clean report.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unterminated JSX element');
    expect(result.stderr).toContain('Broken.jsx');
  });
});

describe('Step 68.2: regex and division projects scan through the CLI', () => {
  it('reports nothing for a regex after await/yield whose text is not declared', async () => {
    const result = await runCli([fixture('regex-await-yield-clean')], OPTIONS);

    // `await /require('fake')/` is a regex literal, so `fake` is not a missing dependency.
    expect(result).toEqual({ exitCode: 0, stdout: CLEAN_REPORT, stderr: '' });
  });

  it('still reports the declared package of that regex as unused', async () => {
    const result = await runCli([fixture('regex-await-yield-declared')], OPTIONS);

    // The mirror case: text inside a regex is not usage evidence either, so `fake` stays unused.
    expect(result).toEqual({
      exitCode: 1,
      stdout: 'DepVitals\n\nUnused dependencies (1)\n  fake\n',
      stderr: '',
    });
  });

  it('reports a require surrounded by divisions', async () => {
    const result = await runCli([fixture('division-require')], OPTIONS);

    // `{} / require('real') / 2` divides twice; the call must stay visible.
    expect(result).toEqual({
      exitCode: 1,
      stdout: 'DepVitals\n\nMissing dependencies (1)\n  real\n',
      stderr: '',
    });
  });
});

describe('Step 68.2: the scanner stays deterministic and non-mutating', () => {
  const projects = [
    'jsx-react-component',
    'jsx-javascript-extensions',
    'jsx-inert-text',
    'jsx-expression-require',
    'jsx-incomplete',
    'regex-await-yield-clean',
    'regex-await-yield-declared',
    'division-require',
  ];

  it.each(projects)('%s produces the same result twice and is left untouched', async (name) => {
    const root = fixture(name);
    const before = snapshot(root);

    const first = await runCli([root], OPTIONS);
    const second = await runCli([root], OPTIONS);

    expect(second).toEqual(first);
    expect(snapshot(root)).toEqual(before);
  });
});

describe('Step 68.2: the packaged entry point wires the JSX mode by extension and content', () => {
  /** Run the built CLI with the update notifier disabled, so only the report is compared. */
  function runBuilt(projectPath: string): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const result = spawnSync(process.execPath, [BUILT_ENTRY, projectPath], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' },
    });

    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('scans a TSX/JSX component tree cleanly', () => {
    expect(runBuilt(fixture('jsx-react-component'))).toEqual({
      status: 0,
      stdout: CLEAN_REPORT,
      stderr: '',
    });
  });

  it('scans JSX in plain JavaScript extensions cleanly', () => {
    expect(runBuilt(fixture('jsx-javascript-extensions'))).toEqual({
      status: 0,
      stdout: CLEAN_REPORT,
      stderr: '',
    });
  });

  it('does not report the text of a regex as a missing dependency', () => {
    expect(runBuilt(fixture('regex-await-yield-clean'))).toEqual({
      status: 0,
      stdout: CLEAN_REPORT,
      stderr: '',
    });
  });
});

describe('Step 75 template interpolation token boundaries', () => {
  it.each(['declared', 'undeclared'] as const)(
    '%s tags preserve real usage and inert text',
    async (mode) => {
      const project = fixture(`template-tag-${mode}`);
      const before = snapshot(project);
      const expected = {
        exitCode: 1,
        stdout:
          mode === 'declared'
            ? 'DepVitals\n\nUnused dependencies (4)\n  fake-member\n  fake-nested\n  fake-tag\n  fake-text\n'
            : 'DepVitals\n\nMissing dependencies (3)\n  real-after\n  real-divisor\n  real-inner\n',
        stderr: '',
      };
      expect(await runCli([project], OPTIONS)).toEqual(expected);
      expect(await runCli([project], OPTIONS)).toEqual(expected);
      const built = spawnSync(process.execPath, [BUILT_ENTRY, project], {
        cwd: tmpdir(),
        encoding: 'utf8',
        env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' },
        timeout: 10_000,
      });
      expect(built.error).toBeUndefined();
      expect({ exitCode: built.status, stdout: built.stdout, stderr: built.stderr }).toEqual(
        expected,
      );
      expect(snapshot(project)).toEqual(before);
    },
  );
});
