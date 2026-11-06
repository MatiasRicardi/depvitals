import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import type * as nodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../../src/cli/runCli.js';
import {
  collectEslintConfigUsage,
  collectEslintManifestUsage,
  findEslintConfigUsage,
  findEslintManifestUsage,
} from '../../../src/detectors/eslintManifestConfig.js';
import {
  collectEslintRcJsonUsage,
  EslintRcJsonError,
  findEslintRcJsonUsage,
} from '../../../src/detectors/eslintRcJsonConfig.js';

const fault = vi.hoisted(() => ({ target: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFsPromises>();
  return {
    ...actual,
    readFile: vi.fn((path: string, encoding?: BufferEncoding) => {
      if (path === fault.target) {
        const error = new Error('Simulated EACCES') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return actual.readFile(path, encoding);
    }),
  };
});

const declared = new Set(['eslint-config-airbnb', 'eslint-config-prettier', 'eslint-plugin-react']);
const manifest = JSON.stringify({
  devDependencies: Object.fromEntries([...declared].map((name) => [name, '1'])),
  eslintConfig: { extends: 'prettier' },
});
async function project(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'depvitals-eslint-evidence-')));
  try {
    await writeFile(join(root, 'package.json'), manifest);
    for (const [name, value] of Object.entries(files)) await writeFile(join(root, name), value);
    await run(root);
  } finally {
    fault.target = '';
    await rm(root, { recursive: true, force: true });
  }
}

describe('pure ESLint evidence', () => {
  it('retains exact scalar values and the manifest field rather than fabricated coordinates', () => {
    expect(collectEslintConfigUsage({ extends: 'prettier' }, declared)).toEqual([
      {
        packageName: 'eslint-config-prettier',
        evidence: {
          kind: 'config',
          file: 'package.json',
          pointer: '/eslintConfig/extends',
          value: 'prettier',
          detector: 'eslint',
        },
      },
    ]);
  });
  it('keeps original array indices through malformed entries and repeated values', () => {
    const input = Object.freeze({
      extends: Object.freeze([null, 'prettier', 42, 'prettier', 'plugin:react/recommended']),
      plugins: Object.freeze(['react', null, 'react']),
    });
    expect(collectEslintConfigUsage(input, declared)).toEqual([
      {
        packageName: 'eslint-config-prettier',
        evidence: {
          kind: 'config',
          file: 'package.json',
          pointer: '/eslintConfig/extends/1',
          value: 'prettier',
          detector: 'eslint',
        },
      },
      {
        packageName: 'eslint-config-prettier',
        evidence: {
          kind: 'config',
          file: 'package.json',
          pointer: '/eslintConfig/extends/3',
          value: 'prettier',
          detector: 'eslint',
        },
      },
      {
        packageName: 'eslint-plugin-react',
        evidence: {
          kind: 'config',
          file: 'package.json',
          pointer: '/eslintConfig/extends/4',
          value: 'plugin:react/recommended',
          detector: 'eslint',
        },
      },
      {
        packageName: 'eslint-plugin-react',
        evidence: {
          kind: 'config',
          file: 'package.json',
          pointer: '/eslintConfig/plugins/0',
          value: 'react',
          detector: 'eslint',
        },
      },
      {
        packageName: 'eslint-plugin-react',
        evidence: {
          kind: 'config',
          file: 'package.json',
          pointer: '/eslintConfig/plugins/2',
          value: 'react',
          detector: 'eslint',
        },
      },
    ]);
    expect(findEslintConfigUsage(input, declared)).toEqual(
      new Set(['eslint-config-prettier', 'eslint-plugin-react']),
    );
  });
  it('orders pointers lexically while preserving actual indices and reader-supplied path tokens', () => {
    const values: unknown[] = Array.from({ length: 11 }, () => null);
    values[2] = 'prettier';
    values[10] = 'prettier';
    const records = collectEslintConfigUsage({ extends: values }, declared, {
      file: '.ESLINTRC.JSON',
      pointerTokens: ['root/~'],
    });
    expect(
      records.map(({ evidence }) => [evidence.file, evidence.pointer, evidence.value]),
    ).toEqual([
      ['.ESLINTRC.JSON', '/root~1~0/extends/10', 'prettier'],
      ['.ESLINTRC.JSON', '/root~1~0/extends/2', 'prettier'],
    ]);
  });
  it.each([
    ['prettier', 'eslint-config-prettier'],
    ['airbnb', 'eslint-config-airbnb'],
    ['plugin:react/recommended', 'eslint-plugin-react'],
    ['eslint-config-prettier', 'eslint-config-prettier'],
    ['eslint-config-airbnb', 'eslint-config-airbnb'],
  ])('preserves extends mapping %s -> %s', (value, packageName) => {
    expect(collectEslintConfigUsage({ extends: value }, declared)).toEqual([
      {
        packageName,
        evidence: {
          kind: 'config',
          file: 'package.json',
          pointer: '/eslintConfig/extends',
          value,
          detector: 'eslint',
        },
      },
    ]);
  });
  it.each(['react', 'eslint-plugin-react'])('preserves plugin mapping %s', (value) => {
    expect(collectEslintConfigUsage({ plugins: [value] }, declared)).toEqual([
      {
        packageName: 'eslint-plugin-react',
        evidence: {
          kind: 'config',
          file: 'package.json',
          pointer: '/eslintConfig/plugins/0',
          value,
          detector: 'eslint',
        },
      },
    ]);
  });
  it.each([
    null,
    [],
    false,
    1,
    'prettier',
    { plugins: 'react' },
    { extends: { name: 'prettier' } },
    { overrides: [{ extends: 'prettier' }] },
    { 'extends/~': 'prettier' },
    {
      extends: [
        'eslint:recommended',
        'prettier/react',
        'eslint-plugin-react',
        'unknown',
        'Prettier',
      ],
      plugins: ['@scope/react', 'unknown'],
    },
  ])('rejects unsupported shapes/values: %j', (value) => {
    expect(collectEslintConfigUsage(value, declared)).toEqual([]);
  });
  it('drops undeclared aliases and is independent of irrelevant object/declaration ordering', () => {
    expect(collectEslintConfigUsage({ extends: 'prettier' }, new Set())).toEqual([]);
    const a = collectEslintConfigUsage({ extends: 'prettier', plugins: ['react'] }, declared);
    const b = collectEslintConfigUsage(
      { plugins: ['react'], extends: 'prettier' },
      new Set([...declared].reverse()),
    );
    expect(a).toEqual(b);
  });
});

describe('active ESLint config provenance', () => {
  it('reads manifest provenance from the already required text without extra provenance reads', async () => {
    await project({}, async (root) => {
      const start = vi.mocked(readFile).mock.calls.length;
      expect(await collectEslintManifestUsage(root)).toEqual([
        {
          packageName: 'eslint-config-prettier',
          evidence: {
            kind: 'config',
            file: 'package.json',
            pointer: '/eslintConfig/extends',
            value: 'prettier',
            detector: 'eslint',
          },
        },
      ]);
      expect(
        vi
          .mocked(readFile)
          .mock.calls.slice(start)
          .filter(([path]) => path === join(root, 'package.json')),
      ).toHaveLength(2);
      expect(await findEslintManifestUsage(root)).toEqual(new Set(['eslint-config-prettier']));
    });
  });
  it('retains actual rc casing, root-relative pointers and repeated items; displaces manifest', async () => {
    await project(
      {
        '.ESLINTRC.JSON':
          '\ufeff' + JSON.stringify({ extends: ['airbnb', 'airbnb'], plugins: ['react'] }),
      },
      async (root) => {
        const start = vi.mocked(readFile).mock.calls.length;
        expect(await collectEslintRcJsonUsage(root)).toEqual([
          {
            packageName: 'eslint-config-airbnb',
            evidence: {
              kind: 'config',
              file: '.ESLINTRC.JSON',
              pointer: '/extends/0',
              value: 'airbnb',
              detector: 'eslint',
            },
          },
          {
            packageName: 'eslint-config-airbnb',
            evidence: {
              kind: 'config',
              file: '.ESLINTRC.JSON',
              pointer: '/extends/1',
              value: 'airbnb',
              detector: 'eslint',
            },
          },
          {
            packageName: 'eslint-plugin-react',
            evidence: {
              kind: 'config',
              file: '.ESLINTRC.JSON',
              pointer: '/plugins/0',
              value: 'react',
              detector: 'eslint',
            },
          },
        ]);
        const reads = vi.mocked(readFile).mock.calls.slice(start);
        expect(reads.filter(([path]) => path === join(root, '.ESLINTRC.JSON'))).toHaveLength(1);
        expect(reads.filter(([path]) => path === join(root, 'package.json'))).toHaveLength(1);
        expect(await collectEslintManifestUsage(root)).toEqual([]);
        expect(await findEslintRcJsonUsage(root)).toEqual(
          new Set(['eslint-config-airbnb', 'eslint-plugin-react']),
        );
      },
    );
  });
  it('prefers a real canonical lowercase entry when distinct spellings coexist', async () => {
    await project(
      { '.ESLINTRC.JSON': '{"extends":"prettier"}', '.eslintrc.json': '{"extends":"airbnb"}' },
      async (root) => {
        const entries = await readdir(root);
        const file = entries.includes('.eslintrc.json') ? '.eslintrc.json' : '.ESLINTRC.JSON';
        expect(await collectEslintRcJsonUsage(root)).toEqual([
          {
            packageName: 'eslint-config-airbnb',
            evidence: {
              kind: 'config',
              file,
              pointer: '/extends',
              value: 'airbnb',
              detector: 'eslint',
            },
          },
        ]);
      },
    );
  });
  const hardBarriers = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    'eslint.config.mts',
    'eslint.config.cts',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.yaml',
    '.eslintrc.yml',
  ];
  it.each(hardBarriers.flatMap((name) => ['file', 'directory'].map((type) => ({ name, type }))))(
    'barrier $name ($type) prevents both collectors and displaced JSON errors',
    async ({ name, type }) => {
      await project({ '.eslintrc.json': '{ invalid' }, async (root) => {
        if (type === 'directory') await mkdir(join(root, name));
        else await writeFile(join(root, name), 'not executed');
        const start = vi.mocked(readFile).mock.calls.length;
        expect(await collectEslintManifestUsage(root)).toEqual([]);
        expect(await collectEslintRcJsonUsage(root)).toEqual([]);
        expect(vi.mocked(readFile).mock.calls.slice(start)).toHaveLength(0);
      });
    },
  );
  it.each(['file', 'directory'])(
    'extensionless rc %s displaces only manifest, not valid JSON rc',
    async (type) => {
      await project({ '.eslintrc.json': '{"extends":"airbnb"}' }, async (root) => {
        if (type === 'directory') await mkdir(join(root, '.eslintrc'));
        else await writeFile(join(root, '.eslintrc'), 'not read');
        expect(await collectEslintManifestUsage(root)).toEqual([]);
        expect(
          (await collectEslintRcJsonUsage(root)).map(({ evidence }) => evidence.pointer),
        ).toEqual(['/extends']);
      });
    },
  );
  it('a nonregular rc displaces the manifest without inventing evidence', async () => {
    await project({}, async (root) => {
      await mkdir(join(root, '.eslintrc.json'));
      expect(await collectEslintManifestUsage(root)).toEqual([]);
      expect(await collectEslintRcJsonUsage(root)).toEqual([]);
    });
  });
  it('preserves active rc unreadable errors and leaves project input unchanged', async () => {
    await project({ '.eslintrc.json': '{"extends":"airbnb"}' }, async (root) => {
      fault.target = join(root, '.eslintrc.json');
      await expect(collectEslintRcJsonUsage(root)).rejects.toMatchObject({
        name: 'EslintRcJsonError',
        code: 'unreadable',
      });
      await expect(findEslintRcJsonUsage(root)).rejects.toBeInstanceOf(EslintRcJsonError);
      fault.target = '';
      expect(await readFile(join(root, '.eslintrc.json'), 'utf8')).toBe('{"extends":"airbnb"}');
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest);
    });
  });
  it('ignoring rc as a source path does not bypass dedicated strict JSON errors', async () => {
    await project(
      {
        '.eslintrc.json': '{ invalid',
        'depvitals.config.json': JSON.stringify({ ignorePaths: ['.eslintrc.json'] }),
      },
      async (root) => {
        await expect(collectEslintRcJsonUsage(root)).rejects.toMatchObject({
          code: 'invalid-json',
        });
        const result = await runCli([root], { cwd: root, version: '0.3.0' });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('.eslintrc.json');
      },
    );
  });
  it('ignored invalid source barriers remain barriers and do not reactivate either legacy source', async () => {
    await project(
      {
        '.eslintrc.json': '{ invalid',
        'eslint.config.js': 'export /* invalid',
        'depvitals.config.json': JSON.stringify({ ignorePaths: ['eslint.config.js'] }),
      },
      async (root) => {
        expect(await collectEslintManifestUsage(root)).toEqual([]);
        expect(await collectEslintRcJsonUsage(root)).toEqual([]);
        const result = await runCli([root], { cwd: root, version: '0.3.0' });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('eslint-config-prettier');
      },
    );
  });
});
