import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/cli/runCli.js';
import { runCliEntry } from '../src/cli/entry.js';
import { collectUpdateNotice } from '../src/cli/notifier/updateCheck.js';
import { analyzeProject, analyzeProjectWithContext } from '../src/core/analyzeProject.js';
import { createScanContext } from '../src/core/scanContext.js';
import type * as moduleSpecifiers from '../src/scanner/moduleSpecifiers.js';
import type * as scriptUsage from '../src/scanner/scriptUsage.js';
import { collectModuleSpecifiers } from '../src/scanner/moduleSpecifiers.js';
import { collectPackageScriptUsage } from '../src/scanner/scriptUsage.js';

const fault = vi.hoisted(() => ({ readPath: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFile: vi.fn((path: string, encoding?: BufferEncoding) => {
      if (path === fault.readPath)
        throw Object.assign(new Error('Simulated EACCES'), { code: 'EACCES' });
      return actual.readFile(path, encoding);
    }),
    readdir: vi.fn(actual.readdir),
    lstat: vi.fn(actual.lstat),
  };
});
vi.mock('../src/scanner/moduleSpecifiers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof moduleSpecifiers>();
  return { ...actual, collectModuleSpecifiers: vi.fn(actual.collectModuleSpecifiers) };
});
vi.mock('../src/scanner/scriptUsage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof scriptUsage>();
  return { ...actual, collectPackageScriptUsage: vi.fn(actual.collectPackageScriptUsage) };
});
const inventory = {
  name: 'context-root',
  dependencies: { both: '1', unused: '1' },
  devDependencies: {
    'eslint-config-prettier': '1',
    'eslint-plugin-react': '1',
    'ts-jest': '1',
    tool: '1',
  },
  peerDependencies: { 'peer-only': '1' },
  optionalDependencies: { 'optional-only': '1' },
  scripts: { lint: 'unknown-command && tool' },
  eslintConfig: { extends: 'prettier' },
  jest: { preset: 'ts-jest' },
};
const manifestText = JSON.stringify(inventory);
function clear(): void {
  vi.mocked(fs.readFile).mockClear();
  vi.mocked(fs.readdir).mockClear();
  vi.mocked(fs.lstat).mockClear();
  vi.mocked(collectModuleSpecifiers).mockClear();
  vi.mocked(collectPackageScriptUsage).mockClear();
}
async function project(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'depvitals-context-')));
  try {
    await fs.writeFile(join(root, 'package.json'), manifestText);
    for (const [name, text] of Object.entries(files)) {
      await fs.mkdir(dirname(join(root, name)), { recursive: true });
      await fs.writeFile(join(root, name), text);
    }
    clear();
    await run(root);
  } finally {
    fault.readPath = '';
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
}
function reads(): unknown[] {
  return vi.mocked(fs.readFile).mock.calls.map(([path]) => path);
}

describe('one per-scan CLI input context', () => {
  it.each([false, true])(
    'loads/parses root once and collects each channel once (rc=%s)',
    async (rc) => {
      await project(
        {
          'index.js': "import 'both'; import 'peer-only'; import 'missing';",
          'depvitals.config.json': JSON.stringify({ ignoreDependencies: ['unused'] }),
          ...(rc ? { '.ESLINTRC.JSON': '{"plugins":["react"]}' } : {}),
        },
        async (root) => {
          const parse = vi.spyOn(JSON, 'parse');
          try {
            const context = await createScanContext(root);
            expect(context.manifest.root).toBe(root);
            expect(context.rawManifest['name']).toBe('context-root');
            expect(context.manifest.peerDependencies).toEqual({ 'peer-only': '1' });
            expect(context.manifest.optionalDependencies).toEqual({ 'optional-only': '1' });
            expect(context.config.ignoreDependencies).toEqual(['unused']);
            expect(context.configEvidence).toEqual([
              rc
                ? {
                    packageName: 'eslint-plugin-react',
                    evidence: {
                      kind: 'config',
                      file: '.ESLINTRC.JSON',
                      pointer: '/plugins/0',
                      value: 'react',
                      detector: 'eslint',
                    },
                  }
                : {
                    packageName: 'eslint-config-prettier',
                    evidence: {
                      kind: 'config',
                      file: 'package.json',
                      pointer: '/eslintConfig/extends',
                      value: 'prettier',
                      detector: 'eslint',
                    },
                  },
              {
                packageName: 'ts-jest',
                evidence: {
                  kind: 'config',
                  file: 'package.json',
                  pointer: '/jest/preset',
                  value: 'ts-jest',
                  detector: 'jest',
                },
              },
            ]);
            const result = await analyzeProjectWithContext(context);
            expect(result).toEqual({
              projectRoot: root,
              unusedDependencies: [],
              unusedDevDependencies: [rc ? 'eslint-config-prettier' : 'eslint-plugin-react'],
              missingDependencies: ['missing'],
            });
            expect(reads().filter((path) => path === join(root, 'package.json'))).toHaveLength(1);
            expect(
              reads().filter((path) => path === join(root, 'depvitals.config.json')),
            ).toHaveLength(1);
            expect(reads().filter((path) => path === join(root, 'index.js'))).toHaveLength(1);
            expect(reads().filter((path) => path === join(root, '.ESLINTRC.JSON'))).toHaveLength(
              rc ? 1 : 0,
            );
            expect(parse.mock.calls.filter(([text]) => text === manifestText)).toHaveLength(1);
            const listings: readonly (readonly unknown[])[] = vi
              .mocked(fs.readdir)
              .mock.calls.filter(([path]) => path === root);
            expect(listings).toHaveLength(2); // one name-only policy/precedence listing plus source discovery
            expect(listings.filter(([, options]) => options === undefined)).toHaveLength(1);
            expect(collectModuleSpecifiers).toHaveBeenCalledTimes(1);
            expect(collectPackageScriptUsage).toHaveBeenCalledTimes(1);
            expect(vi.mocked(collectPackageScriptUsage).mock.results[0]?.value).toEqual([
              {
                packageName: 'tool',
                evidence: {
                  kind: 'script',
                  file: 'package.json',
                  pointer: '/scripts/lint',
                  command: 'tool',
                  via: 'direct',
                  occurrence: 1,
                },
              },
            ]);
          } finally {
            parse.mockRestore();
          }
        },
      );
    },
  );
  it.each(['manifest ESLint', 'legacy ESLint', 'manifest Jest'] as const)(
    'retains a large batch of %s occurrences in evidence order',
    async (detector) => {
      const count = 130_000;
      const isJest = detector === 'manifest Jest';
      const legacy = detector === 'legacy ESLint';
      const plugins = Array<string>(count).fill('react');
      const manifest = isJest
        ? {
            ...inventory,
            jest: {
              transform: Object.fromEntries(
                Array.from({ length: count }, (_, index) => [String(index), 'ts-jest']),
              ),
            },
          }
        : { ...inventory, eslintConfig: { plugins } };
      await project(
        {
          'package.json': JSON.stringify(manifest),
          ...(legacy ? { '.ESLINTRC.JSON': JSON.stringify({ plugins }) } : {}),
        },
        async (root) => {
          const { configEvidence } = await createScanContext(root);
          expect(configEvidence).toHaveLength(count + 1);
          const prefix = isJest ? '/jest/transform' : legacy ? '/plugins' : '/eslintConfig/plugins';
          const file = legacy ? '.ESLINTRC.JSON' : 'package.json';
          const packageName = isJest ? 'ts-jest' : 'eslint-plugin-react';
          const start = isJest ? 1 : 0;
          expect(configEvidence[start]).toMatchObject({
            packageName,
            evidence: { file, pointer: prefix + '/0', detector: isJest ? 'jest' : 'eslint' },
          });
          expect(configEvidence[start + count - 1]).toMatchObject({
            packageName,
            evidence: { file, pointer: prefix + '/99999' },
          });
          expect(configEvidence[isJest ? 0 : count]?.packageName).toBe(
            isJest ? 'eslint-config-prettier' : 'ts-jest',
          );
        },
      );
    },
    15_000,
  );

  it('CLI uses the selected root from an alternate cwd, without reloading the manifest', async () => {
    await project({ 'index.cjs': "require('both');" }, async (root) => {
      const runner = join(root, 'runner');
      await fs.mkdir(runner);
      await fs.writeFile(join(runner, 'depvitals.config.json'), '{ invalid');
      clear();
      const result = await runCli([relative(runner, root)], { cwd: runner, version: '0.3.0' });
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('unused');
      expect(reads().filter((path) => path === join(root, 'package.json'))).toHaveLength(1);
      expect(reads()).not.toContain(join(runner, 'depvitals.config.json'));
    });
  });
  it('refreshes policy and precedence for a later scan instead of keeping a cross-scan cache', async () => {
    await project({}, async (root) => {
      const first = await runCli([root], { cwd: root, version: '0.3.0' });
      expect(first.stdout).not.toContain('eslint-config-prettier');
      await fs.writeFile(join(root, '.eslintrc.json'), '{"plugins":["react"]}');
      await fs.writeFile(
        join(root, 'depvitals.config.json'),
        JSON.stringify({ ignoreDependencies: ['unused'] }),
      );
      clear();
      const second = await runCli([root], { cwd: root, version: '0.3.0' });
      expect(second.stdout).toContain('eslint-config-prettier');
      expect(second.stdout).not.toContain('eslint-plugin-react');
      expect(second.stdout).not.toMatch(/\bunused\b/);
      expect(reads().filter((path) => path === join(root, 'package.json'))).toHaveLength(1);
    });
  });
  it('keeps standalone analysis names-only without implicitly activating detectors or root policy', async () => {
    await project(
      { 'depvitals.config.json': '{ invalid', '.eslintrc.json': '{ invalid' },
      async (root) => {
        const result = await analyzeProject(root);
        expect(result.unusedDevDependencies).toEqual([
          'eslint-config-prettier',
          'eslint-plugin-react',
          'ts-jest',
        ]);
        expect(reads()).toEqual([join(root, 'package.json')]);
        expect(result.missingDependencies).toEqual([]);
      },
    );
  });
  it('retains one nearest-scope read for multiple files and does not promote child inventories', async () => {
    await project(
      {
        'child/package.json': JSON.stringify({
          name: 'child',
          type: 'module',
          dependencies: { inside: '1' },
        }),
        'child/a.js': "import 'inside';",
        'child/b.js': "import 'inside';",
      },
      async (root) => {
        const result = await analyzeProjectWithContext(await createScanContext(root));
        expect(result.missingDependencies).toEqual(['inside']);
        expect(reads().filter((path) => path === join(root, 'package.json'))).toHaveLength(1);
        expect(reads().filter((path) => path === join(root, 'child/package.json'))).toHaveLength(1);
        expect(collectModuleSpecifiers).toHaveBeenCalledTimes(2);
      },
    );
  });
});

describe('mandatory order and error precedence', () => {
  it.each(['{ invalid', JSON.stringify({ dependencies: { broken: 1 } })])(
    'validates mandatory root manifest before policy/detector errors: %s',
    async (text) => {
      await project(
        {
          'package.json': text,
          'depvitals.config.json': '{ invalid',
          '.eslintrc.json': '{ invalid',
          'bad.js': '"unfinished',
        },
        async (root) => {
          const result = await runCli([root], { cwd: root, version: '0.3.0' });
          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe('');
          expect(result.stderr).toContain('package.json');
          expect(reads()).toEqual([join(root, 'package.json')]);
          expect(collectModuleSpecifiers).not.toHaveBeenCalled();
        },
      );
    },
  );
  it('invalid root directory wins before any policy, detector or source reads', async () => {
    await project({ 'file-root': 'not a directory' }, async (root) => {
      const result = await runCli([join(root, 'file-root')], { cwd: root, version: '0.3.0' });
      expect(result.stderr).toContain('not a directory');
      expect(result.stdout).toBe('');
      expect(reads()).toEqual([]);
    });
  });
  it('strict policy validation wins before active detector/source failures', async () => {
    await project(
      {
        'depvitals.config.json': '{"unknown":[]}',
        '.eslintrc.json': '{ invalid',
        'bad.js': '"unfinished',
      },
      async (root) => {
        const result = await runCli([root], { cwd: root, version: '0.3.0' });
        expect(result.stderr).toContain('depvitals.config.json');
        expect(result.stdout).toBe('');
        expect(reads()).toEqual([join(root, 'package.json'), join(root, 'depvitals.config.json')]);
        expect(collectModuleSpecifiers).not.toHaveBeenCalled();
      },
    );
  });
  it('retains policy-listing error identity when the root directory cannot be listed', async () => {
    await project({}, async (root) => {
      vi.mocked(fs.readdir).mockRejectedValueOnce(
        Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      );
      const result = await runCli([root], { cwd: root, version: '0.3.0' });
      expect(result.stderr).toContain('Could not read depvitals.config.json');
      expect(result.stdout).toBe('');
      expect(reads()).toEqual([join(root, 'package.json')]);
    });
  });
  it.each(['invalid', 'unreadable'])(
    'active rc %s fails before source and script collection',
    async (kind) => {
      await project(
        { '.eslintrc.json': kind === 'invalid' ? '{ invalid' : '{}', 'bad.js': '"unfinished' },
        async (root) => {
          if (kind === 'unreadable') fault.readPath = join(root, '.eslintrc.json');
          const result = await runCli([root], { cwd: root, version: '0.3.0' });
          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe('');
          expect(result.stderr).toContain('.eslintrc.json');
          expect(collectModuleSpecifiers).not.toHaveBeenCalled();
          expect(collectPackageScriptUsage).not.toHaveBeenCalled();
        },
      );
    },
  );
  it('ignoring root metadata cannot bypass mandatory validation', async () => {
    await project(
      { 'package.json': '{ invalid', 'depvitals.config.json': '{"ignorePaths":["package.json"]}' },
      async (root) => {
        expect((await runCli([root], { cwd: root, version: '0.3.0' })).stderr).toContain(
          'package.json',
        );
        expect(reads()).toEqual([join(root, 'package.json')]);
      },
    );
  });
  it('ignored child metadata still fails when a retained source needs that scope', async () => {
    await project(
      {
        'child/package.json': '{ invalid',
        'child/keep.js': "import 'inside';",
        'depvitals.config.json': '{"ignorePaths":["child/package.json"]}',
      },
      async (root) => {
        const result = await runCli([root], { cwd: root, version: '0.3.0' });
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(join(root, 'child/package.json'));
        expect(reads().filter((path) => path === join(root, 'child/package.json'))).toHaveLength(1);
      },
    );
  });
  it('ignored source barriers do not reactivate displaced or invalid legacy config', async () => {
    await project(
      {
        'eslint.config.js': 'export /* bad',
        '.eslintrc.json': '{ invalid',
        'depvitals.config.json': '{"ignorePaths":["eslint.config.js"]}',
      },
      async (root) => {
        const result = await runCli([root], { cwd: root, version: '0.3.0' });
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('eslint-config-prettier');
        expect(reads()).not.toContain(join(root, '.eslintrc.json'));
        expect(reads()).not.toContain(join(root, 'eslint.config.js'));
      },
    );
  });
});

describe('meta and argument errors bypass scan/config/detector/notifier I/O', () => {
  it.each([['--help'], ['--version'], ['--unknown'], ['a', 'b']])(
    'does no input or cache/network work for %j',
    async (...args) => {
      await project(
        {
          'package.json': '{ invalid',
          'depvitals.config.json': '{ invalid',
          '.eslintrc.json': '{ invalid',
        },
        async (root) => {
          const fetchImpl = vi.fn(() => Promise.reject(new Error('No network is permitted')));
          const stdout = { isTTY: true, write: vi.fn() };
          const stderr = { isTTY: true, write: vi.fn() };
          await runCliEntry(args, {
            cwd: root,
            version: '0.3.0',
            env: {},
            stdout,
            stderr,
            updateNotice: (request) =>
              collectUpdateNotice(request, { cacheDir: join(root, 'test-cache'), fetchImpl }),
          });
          expect(reads()).toEqual([]);
          expect(fs.readdir).not.toHaveBeenCalled();
          expect(fs.lstat).not.toHaveBeenCalled();
          expect(collectModuleSpecifiers).not.toHaveBeenCalled();
          expect(collectPackageScriptUsage).not.toHaveBeenCalled();
          expect(fetchImpl).not.toHaveBeenCalled();
        },
      );
    },
  );
});
