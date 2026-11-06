import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type * as nodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../../src/cli/runCli.js';
import { analyzeProject } from '../../../src/core/analyzeProject.js';
import {
  collectJestConfigUsage,
  collectJestManifestUsage,
  findJestConfigUsage,
  findJestManifestUsage,
} from '../../../src/detectors/jestManifestConfig.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFsPromises>();
  return {
    ...actual,
    readFile: vi.fn((path: string, encoding?: BufferEncoding) => actual.readFile(path, encoding)),
  };
});
const declared = new Set(['ts-jest', 'jest-environment-jsdom']);
const manifest = JSON.stringify({
  devDependencies: { 'ts-jest': '1', 'jest-environment-jsdom': '1' },
  jest: {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'jest-environment-jsdom',
    transform: { 'x/y~': ['ts-jest/preprocessor.js', {}] },
  },
});
async function project(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'depvitals-jest-evidence-')));
  try {
    await writeFile(join(root, 'package.json'), manifest);
    for (const [name, value] of Object.entries(files)) await writeFile(join(root, name), value);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('pure Jest configuration provenance', () => {
  it('keeps repeated package values in distinct fields and points tuple provenance to its module', () => {
    const config = Object.freeze({
      preset: 'ts-jest/presets/default-esm',
      testEnvironment: 'jest-environment-jsdom/build/index.js',
      transform: Object.freeze({
        'x/y~z': Object.freeze(['ts-jest/preprocessor.js', Object.freeze({ label: 'ignored' })]),
        plain: 'ts-jest',
      }),
    });
    expect(collectJestConfigUsage(config, declared)).toEqual([
      {
        packageName: 'jest-environment-jsdom',
        evidence: {
          kind: 'config',
          file: 'package.json',
          pointer: '/jest/testEnvironment',
          value: 'jest-environment-jsdom/build/index.js',
          detector: 'jest',
        },
      },
      {
        packageName: 'ts-jest',
        evidence: {
          kind: 'config',
          file: 'package.json',
          pointer: '/jest/preset',
          value: 'ts-jest/presets/default-esm',
          detector: 'jest',
        },
      },
      {
        packageName: 'ts-jest',
        evidence: {
          kind: 'config',
          file: 'package.json',
          pointer: '/jest/transform/plain',
          value: 'ts-jest',
          detector: 'jest',
        },
      },
      {
        packageName: 'ts-jest',
        evidence: {
          kind: 'config',
          file: 'package.json',
          pointer: '/jest/transform/x~1y~0z/0',
          value: 'ts-jest/preprocessor.js',
          detector: 'jest',
        },
      },
    ]);
    expect(findJestConfigUsage(config, declared)).toEqual(
      new Set(['jest-environment-jsdom', 'ts-jest']),
    );
  });
  it('escapes pointer components once without URL encoding or regex evaluation', () => {
    const transform = Object.fromEntries([
      ['~1/\n😀', 'ts-jest'],
      ['', 'ts-jest'],
      ['(?invalid', 'ts-jest'],
      ['__proto__', 'ts-jest'],
    ]);
    const records = collectJestConfigUsage({ transform }, declared);
    expect(records.map(({ evidence }) => evidence.pointer)).toEqual([
      '/jest/transform/',
      '/jest/transform/(?invalid',
      '/jest/transform/__proto__',
      '/jest/transform/~01~1\n😀',
    ]);
  });
  it('sorts independently of input insertion order without collapsing pointer identities', () => {
    const transform = { z: 'ts-jest', a: ['ts-jest', {}] };
    const a = collectJestConfigUsage({ preset: 'ts-jest', transform }, declared);
    const b = collectJestConfigUsage(
      { transform: Object.fromEntries(Object.entries(transform).reverse()), preset: 'ts-jest' },
      new Set([...declared].reverse()),
    );
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
  });
  it.each(['ts-jest', 'ts-jest/presets/default-esm'])(
    'retains exact preset selector %s',
    (value) => {
      expect(collectJestConfigUsage({ preset: value }, declared)).toEqual([
        {
          packageName: 'ts-jest',
          evidence: {
            kind: 'config',
            file: 'package.json',
            pointer: '/jest/preset',
            value,
            detector: 'jest',
          },
        },
      ]);
    },
  );
  it.each(
    [
      null,
      [],
      false,
      1,
      'ts-jest',
      { preset: ['ts-jest'] },
      { preset: { name: 'ts-jest' } },
      { testEnvironment: 'jsdom' },
      { testEnvironment: 'jest-environment-node' },
      { coverageProvider: 'ts-jest' },
      { projects: [{ preset: 'ts-jest' }] },
      { transform: [] },
      { transform: 'ts-jest' },
      { transform: { 'ts-jest': 'unknown', 'jest-environment-jsdom': 'unknown' } },
    ].map((config) => ({ config })),
  )('ignores unsupported top-level/field shapes and decoys $config', ({ config }) => {
    expect(collectJestConfigUsage(config, declared)).toEqual([]);
  });
  it.each([
    './local',
    '/opt/local',
    '<rootDir>/transform.js',
    'file:./transform.js',
    'https://example.invalid/ts-jest',
    'ts-jest@latest',
    'TS-Jest',
    'ts-jest-extra',
    '',
    'ts jest',
    'jsdom',
    'jest-environment-jsdom',
  ])('does not credit unsupported transformer selector %s', (value) => {
    expect(collectJestConfigUsage({ transform: { pattern: value } }, declared)).toEqual([]);
  });
  it.each(
    [
      [],
      ['ts-jest'],
      ['ts-jest', {}, {}],
      ['ts-jest', null],
      ['ts-jest', []],
      ['ts-jest', false],
      ['ts-jest', 'options'],
      [['ts-jest'], {}],
      [{ module: 'ts-jest' }, {}],
      ['unknown', { module: 'ts-jest' }],
    ].map((value) => ({ value })),
  )('does not extract package names from malformed tuple/options $value', ({ value }) => {
    expect(collectJestConfigUsage({ transform: { pattern: value } }, declared)).toEqual([]);
  });
  it('never emits eligible config evidence for undeclared targets', () => {
    expect(
      collectJestConfigUsage(
        {
          preset: 'ts-jest',
          testEnvironment: 'jest-environment-jsdom',
          transform: { pattern: ['ts-jest', {}] },
        },
        new Set(),
      ),
    ).toEqual([]);
  });
});

describe('active Jest manifest provenance', () => {
  it('reuses existing standalone reads and leaves the input unchanged', async () => {
    await project({}, async (root) => {
      const start = vi.mocked(readFile).mock.calls.length;
      expect(await collectJestManifestUsage(root)).toEqual([
        {
          packageName: 'jest-environment-jsdom',
          evidence: {
            kind: 'config',
            file: 'package.json',
            pointer: '/jest/testEnvironment',
            value: 'jest-environment-jsdom',
            detector: 'jest',
          },
        },
        {
          packageName: 'ts-jest',
          evidence: {
            kind: 'config',
            file: 'package.json',
            pointer: '/jest/preset',
            value: 'ts-jest/presets/default-esm',
            detector: 'jest',
          },
        },
        {
          packageName: 'ts-jest',
          evidence: {
            kind: 'config',
            file: 'package.json',
            pointer: '/jest/transform/x~1y~0/0',
            value: 'ts-jest/preprocessor.js',
            detector: 'jest',
          },
        },
      ]);
      expect(
        vi
          .mocked(readFile)
          .mock.calls.slice(start)
          .filter(([path]) => path === join(root, 'package.json')),
      ).toHaveLength(2);
      expect(await findJestManifestUsage(root)).toEqual(
        new Set(['jest-environment-jsdom', 'ts-jest']),
      );
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest);
    });
  });
  const barriers = [
    'jest.config.js',
    'jest.config.mjs',
    'jest.config.cjs',
    'jest.config.ts',
    'jest.config.json',
  ];
  it.each(
    barriers.flatMap((name) =>
      [name, name.toUpperCase()].flatMap((name) =>
        ['file', 'directory'].map((type) => ({ name, type })),
      ),
    ),
  )('root barrier $name ($type) yields no config reads or facts', async ({ name, type }) => {
    await project({}, async (root) => {
      if (type === 'directory') await mkdir(join(root, name));
      else await writeFile(join(root, name), 'not read or executed');
      const start = vi.mocked(readFile).mock.calls.length;
      expect(await collectJestManifestUsage(root)).toEqual([]);
      expect(await findJestManifestUsage(root)).toEqual(new Set());
      expect(vi.mocked(readFile).mock.calls.slice(start)).toHaveLength(0);
    });
  });
  it.each(['jest.config.mts', 'jest.config.cts', 'jest.config.yaml'])(
    'does not widen the fixed barrier list to %s',
    async (name) => {
      await project({ [name]: 'not interpreted' }, async (root) => {
        expect(await collectJestManifestUsage(root)).toHaveLength(3);
      });
    },
  );
  it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])(
    'preserves config eligibility through declared group %s',
    async (group) => {
      await project(
        {
          'package.json': JSON.stringify({
            [group]: { 'ts-jest': '1' },
            jest: { preset: 'ts-jest' },
          }),
        },
        async (root) => {
          expect(
            (await collectJestManifestUsage(root)).map(({ packageName }) => packageName),
          ).toEqual(['ts-jest']);
        },
      );
    },
  );
  it('uses JSON last-key semantics rather than recovering overwritten transform values', async () => {
    await project(
      {
        'package.json':
          '{"devDependencies":{"ts-jest":"1"},"jest":{"transform":{"same":"ts-jest","same":["ts-jest/sub",{}]}}}',
      },
      async (root) => {
        expect(await collectJestManifestUsage(root)).toEqual([
          {
            packageName: 'ts-jest',
            evidence: {
              kind: 'config',
              file: 'package.json',
              pointer: '/jest/transform/same/0',
              value: 'ts-jest/sub',
              detector: 'jest',
            },
          },
        ]);
      },
    );
  });
  it('keeps manifest errors with mandatory metadata validation and empty stdout', async () => {
    await project({ 'package.json': '{ invalid' }, async (root) => {
      expect(await collectJestManifestUsage(root)).toEqual([]);
      const result = await runCli([root], { cwd: root, version: '0.3.0' });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('package.json');
    });
  });
  it('ignored invalid source barriers never reactivate the manifest block', async () => {
    await project(
      {
        'Jest.Config.JS': 'export /* invalid',
        'depvitals.config.json': JSON.stringify({ ignorePaths: ['Jest.Config.JS'] }),
      },
      async (root) => {
        expect(await collectJestManifestUsage(root)).toEqual([]);
        const result = await runCli([root], { cwd: root, version: '0.3.0' });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('ts-jest');
      },
    );
  });
  it('config-only hints preserve unused suppression without creating missing findings', async () => {
    await project({}, async (root) => {
      const configUsedNames = await findJestManifestUsage(root);
      const result = await analyzeProject(root, { configUsedNames });
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });
    await project(
      { 'package.json': JSON.stringify({ jest: { preset: 'ts-jest' } }) },
      async (root) => {
        const configUsedNames = await findJestManifestUsage(root);
        expect(configUsedNames).toEqual(new Set());
        expect((await analyzeProject(root, { configUsedNames })).missingDependencies).toEqual([]);
      },
    );
  });
});
