import { readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCliArgs } from '../src/cli/parseCliArgs.js';
import { type CliOptions, runCli } from '../src/cli/runCli.js';

/**
 * The repository manifest is typed as `unknown` on purpose: only the version field is asserted,
 * which is the single source of truth the CLI depends on.
 */
const manifest: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const version = (manifest as { version: string }).version;

const OPTIONS: CliOptions = { version, cwd: tmpdir() };

const ANALYSIS_FIXTURES = fileURLToPath(new URL('./fixtures/analysis/', import.meta.url));
const MANIFEST_FIXTURES = fileURLToPath(new URL('./fixtures/manifest/', import.meta.url));

/** Absolute path to a committed analysis fixture. */
function analysisFixture(path: string): string {
  return join(ANALYSIS_FIXTURES, path);
}

/** Exact terminal report for the committed fixtures, so integration tests assert real output. */
const CLEAN_REPORT = 'DepVitals\n\nNo dependency issues found.\n';

/**
 * Resolve the fixtures directory so relative path tests can pass a bare directory name as the
 * positional argument.
 */
function relativeFixture(path: string): string {
  return path;
}

describe('parseCliArgs', () => {
  describe('no arguments', () => {
    it('scans the injected cwd', () => {
      expect(parseCliArgs([], '/proj')).toEqual({ kind: 'scan', projectPath: '/proj' });
    });
  });

  describe('one positional argument', () => {
    it('scans the resolved absolute path', () => {
      expect(parseCliArgs(['some/project'], '/cwd')).toEqual({
        kind: 'scan',
        projectPath: resolve('/cwd', 'some/project'),
      });
    });

    it('rejects an explicitly empty project path', () => {
      const result = parseCliArgs([''], '/cwd');

      expect(result).toEqual({
        kind: 'error',
        message:
          'Invalid project path: project path must not be empty.\n' +
          "Run 'depvitals --help' for available commands.",
      });
    });

    it('rejects an unknown single option', () => {
      const result = parseCliArgs(['--scan'], '/cwd');

      expect(result).toEqual({
        kind: 'error',
        message: "Unknown option: --scan\nRun 'depvitals --help' for available commands.",
      });
    });
  });

  describe('meta flags', () => {
    it('recognizes --help', () => {
      expect(parseCliArgs(['--help'], '/cwd')).toEqual({ kind: 'help' });
    });

    it('recognizes -h', () => {
      expect(parseCliArgs(['-h'], '/cwd')).toEqual({ kind: 'help' });
    });

    it('recognizes --version', () => {
      expect(parseCliArgs(['--version'], '/cwd')).toEqual({ kind: 'version' });
    });

    it('recognizes -v', () => {
      expect(parseCliArgs(['-v'], '/cwd')).toEqual({ kind: 'version' });
    });
  });

  describe('too many arguments', () => {
    it('rejects two positional paths', () => {
      const result = parseCliArgs(['a', 'b'], '/cwd');

      expect(result).toEqual({
        kind: 'error',
        message:
          'Too many arguments: expected at most one project path.\n' +
          "Run 'depvitals --help' for available commands.",
      });
    });

    it('rejects a meta flag combined with a project path', () => {
      expect(parseCliArgs(['--help', 'project'], '/cwd')).toEqual({
        kind: 'error',
        message:
          "Option --help must be used alone.\nRun 'depvitals --help' for available commands.",
      });
      expect(parseCliArgs(['--version', 'project'], '/cwd')).toEqual({
        kind: 'error',
        message:
          "Option --version must be used alone.\nRun 'depvitals --help' for available commands.",
      });
    });

    it('rejects combinations of multiple meta flags', () => {
      expect(parseCliArgs(['--help', '--version'], '/cwd')).toEqual({
        kind: 'error',
        message:
          "Option --help must be used alone.\nRun 'depvitals --help' for available commands.",
      });
      expect(parseCliArgs(['-h', '-v'], '/cwd')).toEqual({
        kind: 'error',
        message: "Option -h must be used alone.\nRun 'depvitals --help' for available commands.",
      });
    });

    it('rejects the -- separator and lone - as unsupported options', () => {
      expect(parseCliArgs(['--'], '/cwd')).toEqual({
        kind: 'error',
        message: "Unknown option: --\nRun 'depvitals --help' for available commands.",
      });
      expect(parseCliArgs(['-'], '/cwd')).toEqual({
        kind: 'error',
        message: "Unknown option: -\nRun 'depvitals --help' for available commands.",
      });
    });

    it('prefers the unknown option over the positional rule', () => {
      const result = parseCliArgs(['--unknown', 'project'], '/cwd');

      expect(result).toEqual({
        kind: 'error',
        message: "Unknown option: --unknown\nRun 'depvitals --help' for available commands.",
      });
    });
  });
});

describe('runCli', () => {
  describe('help and version', () => {
    it('--help exits 0 and shows the scanner usage to stdout', async () => {
      const result = await runCli(['--help'], OPTIONS);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('DepVitals');
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).toContain('depvitals [project]');
      expect(result.stdout).toContain('project          Project directory to analyze');
      expect(result.stdout).toContain('-h, --help');
      expect(result.stdout).toContain('-v, --version');
    });

    it('-h is equivalent to --help', async () => {
      const result = await runCli(['-h'], OPTIONS);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('depvitals [project]');
    });

    it('--version exits 0 and prints only the version from package.json', async () => {
      const result = await runCli(['--version'], OPTIONS);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${version}\n`);
      expect(result.stderr).toBe('');
    });

    it('-v is equivalent to --version', async () => {
      const result = await runCli(['-v'], OPTIONS);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${version}\n`);
    });
  });

  describe('scan', () => {
    it('scans the injected cwd when no argument is given', async () => {
      const result = await runCli([], { ...OPTIONS, cwd: analysisFixture('clean') });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(CLEAN_REPORT);
      expect(result.stderr).toBe('');
    });

    it('scans an explicit relative path', async () => {
      const result = await runCli([relativeFixture('clean')], {
        ...OPTIONS,
        cwd: ANALYSIS_FIXTURES,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(CLEAN_REPORT);
      expect(result.stderr).toBe('');
    });

    it('scans an explicit absolute path', async () => {
      const result = await runCli([analysisFixture('basic')], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe(
        'DepVitals\n\nUnused devDependencies (1)\n  moment\n\nMissing dependencies (1)\n  zod\n',
      );
      expect(result.stderr).toBe('');
    });

    it('reports unused devDependencies and missing dependencies together', async () => {
      const result = await runCli([analysisFixture('basic')], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Unused devDependencies (1)');
      expect(result.stdout).toContain('  moment');
      expect(result.stdout).toContain('Missing dependencies (1)');
      expect(result.stdout).toContain('  zod');
    });

    it('reports every declared dependency as unused when there is no source', async () => {
      const result = await runCli([analysisFixture('no-source')], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe(
        'DepVitals\n\nUnused dependencies (1)\n  axios\n\nUnused devDependencies (1)\n  vitest\n',
      );
    });

    it('treats a script-only undeclared tool as not missing', async () => {
      const result = await runCli([analysisFixture('script-only-undeclared')], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('DepVitals\n\nUnused dependencies (1)\n  left-pad\n');
    });

    it('does not mutate the committed fixtures after a scan', async () => {
      const fixture = analysisFixture('basic');
      const before = snapshotTree(fixture);

      await runCli([fixture], OPTIONS);

      expect(snapshotTree(fixture)).toEqual(before);
    });
  });

  describe('operational errors', () => {
    it('reports the invalid source file and exits 1', async () => {
      const result = await runCli([analysisFixture('invalid-source')], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('could not be analyzed');
      expect(result.stderr).toContain('broken.ts');
    });

    it('fails with a concise error when package.json is missing', async () => {
      const result = await runCli([MANIFEST_FIXTURES], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('No package.json found at');
      expect(result.stderr).toContain('package.json');
    });

    it('fails when the project path does not exist', async () => {
      const result = await runCli([join(tmpdir(), 'does-not-exist-xyz')], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('No package.json found at');
    });

    it('fails with a concise error when package.json is not valid JSON', async () => {
      const result = await runCli([join(MANIFEST_FIXTURES, 'invalid-json')], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('is not valid JSON');
      expect(result.stderr).toContain('package.json');
    });
  });

  describe('CLI errors', () => {
    it('fails with exit 1 for an unknown option and prints a useful stderr', async () => {
      const result = await runCli(['--scan'], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Unknown option: --scan');
      expect(result.stderr).toContain('depvitals --help');
    });

    it('fails with exit 1 for too many positional arguments', async () => {
      const result = await runCli(['a', 'b'], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Too many arguments: expected at most one project path.');
    });

    it('fails with exit 1 when a meta flag is combined with a project path', async () => {
      const result = await runCli(['--help', 'project'], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Option --help must be used alone.');
    });

    it('fails with exit 1 for the unsupported -- separator', async () => {
      const result = await runCli(['--'], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown option: --');
    });
  });

  describe('stdout/stderr separation', () => {
    it('writes the report to stdout and leaves stderr empty for a finding scan', async () => {
      const result = await runCli([analysisFixture('basic')], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(result.stderr).toBe('');
    });

    it('leaves stdout empty and writes the error to stderr for a failed scan', async () => {
      const result = await runCli([analysisFixture('invalid-source')], OPTIONS);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
    });
  });
});

/**
 * Snapshot the committed fixture tree (relative path to absolute contents) so a scan can be
 * asserted to leave it byte-for-byte unchanged.
 */
function snapshotTree(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);

    if (info.isDirectory()) {
      for (const [name, contents] of Object.entries(snapshotTree(full))) {
        snapshot[`${entry}/${name}`] = contents;
      }
    } else {
      snapshot[entry] = readFileSync(full, 'utf8');
    }
  }

  return snapshot;
}
