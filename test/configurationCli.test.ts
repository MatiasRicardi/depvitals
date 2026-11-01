import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCliEntry } from '../src/cli/entry.js';
import { collectUpdateNotice } from '../src/cli/notifier/updateCheck.js';
import { runCli, type CliResult } from '../src/cli/runCli.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    lstat: vi.fn(actual.lstat),
  };
});
afterEach(() => {
  vi.clearAllMocks();
});
const CONFIG = 'depvitals.config.json';
const ENTRY = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const VERSION = '0.2.0';

async function project(
  files: Readonly<Record<string, string>>,
  run: (root: string, sandbox: string) => Promise<void>,
): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-config-cli-'));
  const root = join(sandbox, 'selected project');
  const inputs = { 'package.json': '{}', ...files };
  try {
    for (const [name, text] of Object.entries(inputs)) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    await run(root, sandbox);
    for (const [name, text] of Object.entries(inputs))
      expect(readFileSync(join(root, name), 'utf8')).toBe(text);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
function configReads(root: string): number {
  return vi.mocked(fs.readFile).mock.calls.filter(([path]) => path === join(root, CONFIG)).length;
}
function compiled(args: readonly string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).not.toBeNull();
  return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('scan-only selected-root configuration integration', () => {
  it('loads both policies once, honors the selected path from another cwd, and keeps neighbor evidence', async () => {
    await project(
      {
        'package.json': JSON.stringify({
          dependencies: {
            'ignored-unused': '*',
            'only-generated': '*',
            'remaining-unused': '*',
            used: '*',
          },
        }),
        [CONFIG]: JSON.stringify({
          ignorePaths: ['./src\\generated/'],
          ignoreDependencies: ['ignored-unused', 'ignored-missing'],
        }),
        'index.cjs':
          "require('ignored-missing'); require('real-missing'); throw new Error('must never execute');",
        'src/generated/broken.ts': "import 'only-generated'; import 'unterminated",
        'src/generator/real.ts': "import 'used';",
        'child/depvitals.config.json': '{invalid nested configuration',
        'depvitals.config.js': "throw new Error('must never execute');",
      },
      async (root, sandbox) => {
        const runner = join(sandbox, 'runner');
        mkdirSync(runner);
        writeFileSync(join(sandbox, CONFIG), '{invalid parent configuration');
        writeFileSync(join(runner, CONFIG), '{invalid cwd configuration');
        const expected = {
          exitCode: 1,
          stdout:
            'DepVitals\n\nUnused dependencies (2)\n  only-generated\n  remaining-unused\n\nMissing dependencies (1)\n  real-missing\n',
          stderr: '',
        };
        expect(await runCli(['../selected project'], { cwd: runner, version: VERSION })).toEqual(
          expected,
        );
        expect(configReads(root)).toBe(1);
        expect(vi.mocked(fs.readdir).mock.calls.map(([path]) => path)).not.toContain(
          join(root, 'src/generated'),
        );
        expect(compiled([root], runner)).toEqual(expected);
        expect(compiled(['../selected project'], runner)).toEqual(expected);
        expect(compiled([], root)).toEqual(expected);
      },
    );
  });
  it.each([undefined, '{}', '{"ignorePaths":[],"ignoreDependencies":[]}'])(
    'preserves default report bytes for %j',
    async (text) => {
      await project(
        {
          'package.json': '{"dependencies":{"unused":"*"}}',
          'index.cjs': "require('missing');",
          ...(text === undefined ? {} : { [CONFIG]: text }),
        },
        async (root) => {
          const expected = {
            exitCode: 1,
            stdout:
              'DepVitals\n\nUnused dependencies (1)\n  unused\n\nMissing dependencies (1)\n  missing\n',
            stderr: '',
          };
          expect(await runCli([], { cwd: root, version: VERSION })).toEqual(expected);
          expect(configReads(root)).toBe(text === undefined ? 0 : 1);
          expect(compiled([], root)).toEqual(expected);
        },
      );
    },
  );
  it.each([
    ['{bad', 'valid JSON'],
    ['[]', 'JSON object'],
    ['{"unknown":[]}', 'unknown'],
    ['{"ignorePaths":["../escape"]}', 'ignorePaths[0]'],
    ['{"ignoreDependencies":["@scope/pkg/sub"]}', 'ignoreDependencies[0]'],
  ])(
    'reports invalid configuration %s before detectors or source errors',
    async (text, context) => {
      await project(
        {
          [CONFIG]: text,
          '.eslintrc.json': '{bad legacy JSON',
          'broken.ts': "import 'unterminated",
        },
        async (root) => {
          const result = await runCli([], { cwd: root, version: VERSION });
          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe('');
          expect(result.stderr).toContain(join(root, CONFIG));
          expect(result.stderr).toContain(context);
          expect(result.stderr).not.toContain('Unexpected error');
          expect(configReads(root)).toBe(1);
          expect(vi.mocked(fs.readFile).mock.calls.map(([path]) => path)).not.toContain(
            join(root, '.eslintrc.json'),
          );
          expect(compiled([], root)).toEqual(result);
        },
      );
    },
  );
  it('rejects a present config directory as an operational error', async () => {
    await project({}, async (root) => {
      mkdirSync(join(root, CONFIG));
      const result = await runCli([], { cwd: root, version: VERSION });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(join(root, CONFIG));
      expect(result.stderr).toContain('regular file');
      expect(configReads(root)).toBe(0);
      expect(compiled([], root)).toEqual(result);
    });
  });
  it('keeps root manifest failures before invalid config, detector and source inputs', async () => {
    await project(
      {
        'package.json': '{bad manifest',
        [CONFIG]: '{bad config',
        '.eslintrc.json': '{bad legacy',
        'broken.ts': "import 'unterminated",
      },
      async (root) => {
        const result = await runCli([], { cwd: root, version: VERSION });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(join(root, 'package.json'));
        expect(result.stderr).not.toContain(CONFIG);
        expect(configReads(root)).toBe(0);
        expect(compiled([], root)).toEqual(result);
      },
    );
  });
  it('keeps ignored ESLint/Jest source files as detector barriers without parsing them', async () => {
    await project(
      {
        'package.json': JSON.stringify({
          dependencies: { 'eslint-config-prettier': '*', 'ts-jest': '*' },
          eslintConfig: { extends: 'prettier' },
          jest: { preset: 'ts-jest' },
        }),
        [CONFIG]: JSON.stringify({
          ignorePaths: [
            'eslint.config.js',
            'jest.config.js',
            '.eslintrc.json',
            'package.json',
            CONFIG,
          ],
        }),
        'eslint.config.js': "import 'unterminated",
        'jest.config.js': "import 'unterminated",
        '.eslintrc.json': '{invalid legacy JSON',
      },
      async (root) => {
        const expected = {
          exitCode: 1,
          stdout: 'DepVitals\n\nUnused dependencies (2)\n  eslint-config-prettier\n  ts-jest\n',
          stderr: '',
        };
        expect(await runCli([], { cwd: root, version: VERSION })).toEqual(expected);
        expect(configReads(root)).toBe(1);
        for (const name of ['eslint.config.js', 'jest.config.js', '.eslintrc.json'])
          expect(vi.mocked(fs.readFile).mock.calls.map(([path]) => path)).not.toContain(
            join(root, name),
          );
        expect(compiled([], root)).toEqual(expected);
      },
    );
  });
  it('still reads and validates active legacy JSON when its source filename is ignored', async () => {
    await project(
      {
        [CONFIG]: JSON.stringify({ ignorePaths: ['.eslintrc.json', 'package.json', CONFIG] }),
        '.eslintrc.json': '{bad legacy JSON',
        'broken.ts': "import 'unterminated",
      },
      async (root) => {
        const result = await runCli([], { cwd: root, version: VERSION });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(join(root, '.eslintrc.json'));
        expect(result.stderr).not.toContain('broken.ts');
        expect(configReads(root)).toBe(1);
        expect(compiled([], root)).toEqual(result);
      },
    );
  });
  it('retains legacy detector hints with valid configuration and no barriers', async () => {
    await project(
      {
        'package.json': JSON.stringify({
          dependencies: { 'eslint-config-prettier': '*', 'ts-jest': '*', ignored: '*' },
          eslintConfig: { extends: 'prettier' },
          jest: { preset: 'ts-jest' },
        }),
        [CONFIG]: '{"ignoreDependencies":["ignored"]}',
      },
      async (root) => {
        const result = await runCli([], { cwd: root, version: VERSION });
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('No dependency issues found');
        expect(compiled([], root)).toEqual(result);
      },
    );
  });
});

describe('configuration and notifier eligibility', () => {
  it.each(['invalid-config', 'help', 'version', 'argument-error', 'clean', 'findings'] as const)(
    'preserves notifier boundaries for %s',
    async (kind) => {
      const eligible = kind === 'clean' || kind === 'findings';
      await project(
        {
          [CONFIG]: eligible ? '{"ignoreDependencies":["selected"]}' : '{bad config',
          'package.json': JSON.stringify({
            dependencies: { selected: '*', ...(kind === 'findings' ? { remaining: '*' } : {}) },
          }),
        },
        async (root, sandbox) => {
          const cacheDir = join(sandbox, 'notifier-cache');
          const fetchImpl = vi.fn(() => Promise.reject(new Error('offline test transport')));
          const updateNotice = vi.fn((request: Parameters<typeof collectUpdateNotice>[0]) =>
            collectUpdateNotice(request, { cacheDir, fetchImpl, now: () => 1700000000000 }),
          );
          const argv =
            kind === 'help'
              ? ['--help']
              : kind === 'version'
                ? ['--version']
                : kind === 'argument-error'
                  ? ['--bad']
                  : [];
          let stdout = '';
          let stderr = '';
          const result = await runCliEntry(argv, {
            cwd: root,
            version: VERSION,
            env: {},
            stdout: {
              isTTY: true,
              write: (chunk) => {
                stdout += chunk;
              },
            },
            stderr: {
              isTTY: true,
              write: (chunk) => {
                stderr += chunk;
              },
            },
            updateNotice,
          });
          expect(fetchImpl).toHaveBeenCalledTimes(eligible ? 1 : 0);
          const cacheChecks = vi
            .mocked(fs.lstat)
            .mock.calls.filter(([path]) => String(path).startsWith(cacheDir));
          expect(cacheChecks).toHaveLength(eligible ? 1 : 0);
          expect(existsSync(cacheDir)).toBe(false);
          expect(updateNotice).toHaveBeenCalledTimes(1);
          expect(updateNotice.mock.calls[0]?.[0].commandKind).toBe(
            kind === 'invalid-config'
              ? 'scan-failure'
              : eligible
                ? 'scan'
                : kind === 'argument-error'
                  ? 'error'
                  : kind,
          );
          if (kind === 'invalid-config') {
            expect(result).toBe(1);
            expect(stdout).toBe('');
            expect(stderr).toContain(join(root, CONFIG));
          } else if (eligible) {
            expect(result).toBe(kind === 'clean' ? 0 : 1);
            expect(stdout).toContain('DepVitals');
            expect(stderr).toBe('');
          } else {
            expect(configReads(root)).toBe(0);
            expect(fs.readFile).not.toHaveBeenCalled();
            expect(fs.lstat).not.toHaveBeenCalled();
            expect(fs.readdir).not.toHaveBeenCalled();
            expect(result).toBe(kind === 'argument-error' ? 1 : 0);
          }
        },
      );
    },
  );
});
