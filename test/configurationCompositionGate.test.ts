import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { runCliEntry } from '../src/cli/entry.js';
import { runCli, type CliResult } from '../src/cli/runCli.js';
import { readProjectConfig, type ProjectConfig } from '../src/config/readProjectConfig.js';
import { analyzeProject, type AnalysisResult } from '../src/core/analyzeProject.js';
import { findEslintManifestUsage } from '../src/detectors/eslintManifestConfig.js';
import { findEslintRcJsonUsage } from '../src/detectors/eslintRcJsonConfig.js';
import { findJestManifestUsage } from '../src/detectors/jestManifestConfig.js';

const FIXTURE = fileURLToPath(
  new URL('./fixtures/analysis/configuration-composition/', import.meta.url),
);
const ENTRY = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const CONFIG = 'depvitals.config.json';
const VERSION = '0.2.0';
type Golden = {
  configUsedNames: readonly string[];
  analysis: Omit<AnalysisResult, 'projectRoot'>;
  cli: CliResult;
};
// Independent, hand-specified arrays and report counts; never generated with the analyzer/reporter.
const EXPECTED = JSON.parse(
  readFileSync(
    new URL('./fixtures/analysis/configuration-composition.expected.json', import.meta.url),
    'utf8',
  ),
) as { policy: ProjectConfig; default: Golden; configured: Golden; barrier: Golden };

/** Snapshot links as links, never read through them into another tree. */
function snapshot(root: string): readonly string[] {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split('\\').join('/');
      if (entry.isSymbolicLink()) entries.push(`link:${name}:${readlinkSync(path)}`);
      else if (entry.isDirectory()) {
        entries.push(`dir:${name}`);
        walk(path);
      } else entries.push(`file:${name}:${readFileSync(path).toString('hex')}`);
    }
  };
  walk(root);
  return entries.sort();
}
async function project(
  work: (root: string, runner: string, sandbox: string) => Promise<void>,
): Promise<void> {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'depvitals-config-composition-')));
  const root = join(sandbox, 'selected project');
  const runner = join(sandbox, 'runner');
  try {
    cpSync(FIXTURE, root, { recursive: true });
    mkdirSync(runner);
    // These documents must never affect an explicitly selected project.
    writeFileSync(join(sandbox, CONFIG), '{bad parent config');
    writeFileSync(join(runner, CONFIG), '{bad cwd config');
    await work(root, runner, sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
function write(root: string, name: string, text: string): void {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function configure(root: string, extraPaths: readonly string[] = []): void {
  write(
    root,
    CONFIG,
    JSON.stringify({
      ...EXPECTED.policy,
      ignorePaths: [...EXPECTED.policy.ignorePaths, ...extraPaths],
    }),
  );
}
async function hints(root: string): Promise<ReadonlySet<string>> {
  return new Set([
    ...(await findEslintManifestUsage(root)),
    ...(await findEslintRcJsonUsage(root)),
    ...(await findJestManifestUsage(root)),
  ]);
}
function compiled(root: string, runner: string): CliResult {
  const result = spawnSync(process.execPath, [ENTRY, relative(runner, root)], {
    cwd: runner,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).not.toBeNull();
  return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}
async function adapter(
  root: string,
  runner: string,
  expected: CliResult,
  failure: boolean,
): Promise<void> {
  let stdout = '';
  let stderr = '';
  const updateNotice = vi.fn((request: { commandKind: string }) => {
    expect(request.commandKind).toBe(failure ? 'scan-failure' : 'scan');
    expect(Object.keys(request).sort()).toEqual([
      'commandKind',
      'currentVersion',
      'env',
      'stderrTTY',
      'stdoutTTY',
    ]);
    return Promise.resolve(failure ? undefined : '\nInjected offline notice\n');
  });
  const exitCode = await runCliEntry([relative(runner, root)], {
    cwd: runner,
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
  expect(updateNotice).toHaveBeenCalledTimes(1);
  expect({ exitCode, stdout, stderr }).toEqual({
    ...expected,
    stderr: expected.stderr + (failure ? '' : '\nInjected offline notice\n'),
  });
}
async function scan(root: string, runner: string, sandbox: string, golden: Golden): Promise<void> {
  const before = snapshot(sandbox);
  const config = await readProjectConfig(root);
  const configUsedNames = await hints(root);
  expect([...configUsedNames]).toEqual(golden.configUsedNames);
  const result = await analyzeProject(root, { ...config, configUsedNames });
  expect(result).toEqual({ projectRoot: root, ...golden.analysis });
  expect(Object.keys(result).sort()).toEqual([
    'missingDependencies',
    'projectRoot',
    'unusedDependencies',
    'unusedDevDependencies',
  ]);
  expect(await analyzeProject(root, { ...config, configUsedNames })).toEqual(result);
  expect(await runCli([], { cwd: root, version: VERSION })).toEqual(golden.cli);
  expect(await runCli([relative(runner, root)], { cwd: runner, version: VERSION })).toEqual(
    golden.cli,
  );
  expect(compiled(root, runner)).toEqual(golden.cli);
  await adapter(root, runner, golden.cli, false);
  expect(snapshot(sandbox)).toEqual(before);
}
async function error(root: string, runner: string, sandbox: string, path: string): Promise<void> {
  const before = snapshot(sandbox);
  const result = await runCli([root], { cwd: runner, version: VERSION });
  expect(Object.keys(result).sort()).toEqual(['exitCode', 'stderr', 'stdout']);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(path);
  expect(result.stderr).not.toContain('Unexpected error');
  expect(compiled(root, runner)).toEqual(result);
  await adapter(root, runner, result, true);
  expect(snapshot(sandbox)).toEqual(before);
}

describe('Step93 cross-feature configuration compatibility', () => {
  it.each(['absent', 'empty', 'configured'] as const)(
    'composes corrected evidence and exact policy: %s',
    async (variant) => {
      await project(async (root, runner, sandbox) => {
        if (variant === 'empty') write(root, CONFIG, '{}');
        if (variant === 'configured') {
          configure(root);
          write(root, 'ignored/broken.ts', "import 'unterminated");
        }
        await scan(
          root,
          runner,
          sandbox,
          variant === 'configured' ? EXPECTED.configured : EXPECTED.default,
        );
      });
    },
  );
  it.each(['absent', 'empty'] as const)(
    'preserves invalid-source failure without effective scope policy: %s',
    async (variant) => {
      await project(async (root, runner, sandbox) => {
        if (variant === 'empty') write(root, CONFIG, '{}');
        write(root, 'ignored/broken.ts', "import 'unterminated");
        await expect(analyzeProject(root)).rejects.toMatchObject({
          name: 'AnalysisError',
          code: 'invalid-source',
        });
        await error(root, runner, sandbox, join(root, 'ignored/broken.ts'));
      });
    },
  );
  it('keeps excluded flat config source as ESLint/Jest barriers', async () => {
    await project(async (root, runner, sandbox) => {
      configure(root, ['eslint.config.js', 'jest.config.js']);
      write(root, 'ignored/broken.ts', "import 'unterminated");
      write(root, 'eslint.config.js', "import 'unterminated");
      write(root, 'jest.config.js', "import 'unterminated");
      await scan(root, runner, sandbox, EXPECTED.barrier);
    });
  });
  it.each([
    'package.json',
    '.eslintrc.json',
    'child/package.json',
    CONFIG,
    'generated-extra/broken.ts',
  ])('cannot hide required input errors by excluding %s', async (name) => {
    await project(async (root, runner, sandbox) => {
      configure(root, ['child/package.json']);
      write(root, name, name.endsWith('.ts') ? "import 'unterminated" : '{bad JSON');
      await error(root, runner, sandbox, join(root, name));
    });
  });
  it('honors nested self-reference ownership and blocks root ownership at a nameless child scope', async () => {
    await project(async (root, runner, sandbox) => {
      configure(root);
      write(root, 'child/package.json', '{}');
      write(
        root,
        'child/index.cjs',
        "require('root-self/feature'); require('child-self/feature'); require('child-missing');",
      );
      const golden: Golden = {
        ...EXPECTED.configured,
        analysis: {
          ...EXPECTED.configured.analysis,
          unusedDependencies: EXPECTED.configured.analysis.unusedDependencies.filter(
            (name) => name !== 'root-self',
          ),
          missingDependencies: [
            'child-missing',
            'child-self',
            'genuine-missing',
            'selected-missing-extra',
          ],
        },
        cli: {
          exitCode: 1,
          stdout:
            'DepVitals\n\nUnused dependencies (9)\n  eslint-config-prettier\n  gulp-cli\n  property-fake\n  regex-fake\n  selected-unused-extra\n  shadow-fake\n  shell-payload\n  source-only\n  unused-z\n\nUnused devDependencies (1)\n  unused-dev\n\nMissing dependencies (4)\n  child-missing\n  child-self\n  genuine-missing\n  selected-missing-extra\n',
          stderr: '',
        },
      };
      await scan(root, runner, sandbox, golden);
    });
  });
  it('skips source links without reading their targets under explicit exclusions', async (context) => {
    await project(async (root, runner, sandbox) => {
      configure(root);
      const outside = join(sandbox, 'outside');
      mkdirSync(outside);
      write(outside, 'source.ts', "import 'linked-only-missing';");
      write(outside, 'package.json', '{bad outside metadata');
      try {
        await symlink(outside, join(root, 'linked-directory'), 'junction');
        await symlink(join(outside, 'source.ts'), join(root, 'linked-source.ts'), 'file');
      } catch (cause) {
        if (
          process.platform === 'win32' &&
          cause instanceof Error &&
          'code' in cause &&
          ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(cause.code))
        )
          context.skip('Symlink creation unavailable');
        throw cause;
      }
      await scan(root, runner, sandbox, EXPECTED.configured);
    });
  });
  for (const kind of ['selected-root', 'root-manifest', 'nested-manifest'] as const) {
    it(`rejects linked mandatory boundaries: ${kind}`, async (context) => {
      await project(async (root, runner, sandbox) => {
        configure(root, ['child/package.json']);
        const target = join(sandbox, 'outside-package.json');
        writeFileSync(target, '{}');
        let selectedRoot = root;
        const path =
          kind === 'selected-root'
            ? join(sandbox, 'root-alias')
            : join(root, kind === 'root-manifest' ? 'package.json' : 'child/package.json');
        if (kind !== 'selected-root') rmSync(path);
        try {
          await symlink(
            kind === 'selected-root' ? root : target,
            path,
            kind === 'selected-root' ? 'junction' : 'file',
          );
        } catch (cause) {
          if (
            process.platform === 'win32' &&
            cause instanceof Error &&
            'code' in cause &&
            ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(cause.code))
          )
            context.skip('Symlink creation unavailable');
          throw cause;
        }
        if (kind === 'selected-root') selectedRoot = path;
        await error(selectedRoot, runner, sandbox, path);
      });
    });
  }
});
