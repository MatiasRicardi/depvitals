import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeIgnorePaths } from '../../../src/config/ignorePaths.js';
import { analyzeProject } from '../../../src/core/analyzeProject.js';
import { findEslintManifestUsage } from '../../../src/detectors/eslintManifestConfig.js';
import { findEslintRcJsonUsage } from '../../../src/detectors/eslintRcJsonConfig.js';
import { findJestManifestUsage } from '../../../src/detectors/jestManifestConfig.js';
import { discoverSourceFiles } from '../../../src/scanner/sourceFiles.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    lstat: vi.fn(actual.lstat),
  };
});
afterEach(() => vi.clearAllMocks());

async function project(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'depvitals-source-exclusions-'));
  try {
    writeFileSync(join(root, 'package.json'), '{}');
    for (const [name, text] of Object.entries(files)) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    await run(root);
    for (const [name, text] of Object.entries(files))
      expect(readFileSync(join(root, name), 'utf8')).toBe(text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function options(root: string, ...rules: string[]): { readonly ignorePaths: readonly string[] } {
  return { ignorePaths: normalizeIgnorePaths(rules, join(root, 'depvitals.config.json')) };
}
function reads(): unknown[] {
  return vi.mocked(fs.readFile).mock.calls.map(([path]) => path);
}
function listings(): unknown[] {
  return vi.mocked(fs.readdir).mock.calls.map(([path]) => path);
}

const baseline = fileURLToPath(
  new URL('../../fixtures/analysis/audit-fix-baseline', import.meta.url),
);

describe('validated source exclusions in discovery and direct analysis', () => {
  it('prunes an invalid subtree before enumeration, metadata lookup or source reads; retains its prefix neighbor', async () => {
    await project(
      {
        'src/generated/package.json': '{bad metadata',
        'src/generated/broken.ts': "import 'unterminated",
        'src/generator/real.ts': "import 'real'; throw new Error('must never execute');",
      },
      async (root) => {
        const excluded = join(root, 'src/generated');
        const policy = options(root, './src\\generated/');
        expect(await discoverSourceFiles(root, policy)).toEqual([
          join(root, 'src/generator/real.ts'),
        ]);
        expect(await analyzeProject(root, policy)).toMatchObject({ missingDependencies: ['real'] });
        expect(listings()).not.toContain(excluded);
        expect(reads()).not.toContain(join(excluded, 'broken.ts'));
        expect(reads()).not.toContain(join(excluded, 'package.json'));
        expect(vi.mocked(fs.lstat).mock.calls.map(([path]) => path)).not.toContain(excluded);
      },
    );
  });
  it('skips an exact invalid file before source/mode reads while preserving similarly prefixed files', async () => {
    await project(
      {
        'src/broken.ts': "import 'unterminated",
        'src/broken.tsx': "import 'neighbor';",
        'src/broken.ts-extra.js': "require('other');",
      },
      async (root) => {
        const policy = options(root, 'src/broken.ts');
        expect(await analyzeProject(root, policy)).toMatchObject({
          missingDependencies: ['neighbor', 'other'],
        });
        expect(reads()).not.toContain(join(root, 'src/broken.ts'));
        await expect(analyzeProject(root)).rejects.toMatchObject({ code: 'invalid-source' });
      },
    );
  });
  it('still fails on a retained invalid neighbor, without returning partial findings', async () => {
    await project(
      {
        'src/generated/broken.ts': "import 'unterminated",
        'src/generator/broken.ts': "import 'also unterminated",
      },
      async (root) => {
        await expect(analyzeProject(root, options(root, 'src/generated'))).rejects.toThrow(
          join('src/generator/broken.ts'),
        );
        expect(reads()).not.toContain(join(root, 'src/generated/broken.ts'));
      },
    );
  });
  it('removes only source evidence: sole usages become unused and ignored missing references disappear', async () => {
    await project(
      {
        'package.json': JSON.stringify({
          dependencies: { sole: '*', shared: '*', scripted: '*' },
          devDependencies: { 'sole-dev': '*' },
          scripts: { lint: 'scripted' },
        }),
        'generated/usage.ts':
          "import 'sole'; import 'sole-dev'; import 'shared'; import 'ignored-missing';",
        'retained.ts': "import 'shared'; import 'retained-missing';",
      },
      async (root) => {
        expect(await analyzeProject(root)).toMatchObject({
          unusedDependencies: [],
          unusedDevDependencies: [],
          missingDependencies: ['ignored-missing', 'retained-missing'],
        });
        const result = await analyzeProject(root, options(root, 'generated'));
        expect(result).toEqual({
          projectRoot: root,
          unusedDependencies: ['sole'],
          unusedDevDependencies: ['sole-dev'],
          missingDependencies: ['retained-missing'],
        });
        expect(await analyzeProject(root, options(root, 'generated'))).toEqual(result);
      },
    );
  });
  it('does not bypass the mandatory root manifest by ignoring its filename', async () => {
    await project({ 'package.json': '{bad manifest' }, async (root) => {
      await expect(analyzeProject(root, options(root, 'package.json'))).rejects.toMatchObject({
        name: 'ProjectManifestError',
        code: 'invalid-json',
      });
    });
  });
  it('retains mandatory scope metadata for retained source even when its JSON filename is ignored', async () => {
    await project(
      { 'child/package.json': '{bad manifest', 'child/index.js': "require('real');" },
      async (root) => {
        await expect(
          analyzeProject(root, options(root, 'child/package.json')),
        ).rejects.toMatchObject({ name: 'ProjectManifestError', code: 'invalid-json' });
        expect(reads()).not.toContain(join(root, 'child/index.js'));
      },
    );
  });
  it('reads scope metadata for retained files even when their only sibling source is excluded', async () => {
    await project(
      {
        'child/package.json': '{"type":"commonjs"}',
        'child/ignored.js': "import 'unterminated",
        'child/retained.js': "var await = 4; await / require('script-real') / 2;",
      },
      async (root) => {
        expect(
          await analyzeProject(root, options(root, 'child/ignored.js', 'child/package.json')),
        ).toMatchObject({ missingDependencies: ['script-real'] });
        expect(reads()).toContain(join(root, 'child/package.json'));
        expect(reads()).not.toContain(join(root, 'child/ignored.js'));
      },
    );
  });
  it('does not change detector barriers or dedicated legacy JSON reads', async () => {
    await project(
      {
        'package.json': JSON.stringify({
          dependencies: { 'eslint-config-prettier': '*', 'ts-jest': '*' },
          eslintConfig: { extends: 'prettier' },
          jest: { preset: 'ts-jest' },
        }),
        'eslint.config.js': "import 'unterminated",
        'jest.config.js': "import 'unterminated",
        '.eslintrc.json': '{invalid legacy JSON',
      },
      async (root) => {
        const policy = options(root, 'eslint.config.js', 'jest.config.js', '.eslintrc.json');
        expect([...(await findEslintManifestUsage(root))]).toEqual([]);
        expect([...(await findEslintRcJsonUsage(root))]).toEqual([]);
        expect([...(await findJestManifestUsage(root))]).toEqual([]);
        expect(await analyzeProject(root, policy)).toMatchObject({
          unusedDependencies: ['eslint-config-prettier', 'ts-jest'],
        });
        await fs.unlink(join(root, 'eslint.config.js'));
        await expect(findEslintRcJsonUsage(root)).rejects.toMatchObject({
          name: 'EslintRcJsonError',
        });
        // Restore the test input for the non-mutation assertion.
        writeFileSync(join(root, 'eslint.config.js'), "import 'unterminated");
      },
    );
  });
  it('keeps fixed exclusions and skips discovered links with custom exclusions active', async (context) => {
    await project(
      {
        'real/index.ts': "import 'real';",
        'node_modules/hidden.ts': "import 'unterminated",
        'dist/hidden.ts': "import 'unterminated",
        'skip.ts': '',
      },
      async (root) => {
        try {
          await fs.symlink(join(root, 'real'), join(root, 'linked'), 'junction');
        } catch (error) {
          if (
            process.platform === 'win32' &&
            error instanceof Error &&
            'code' in error &&
            ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))
          )
            context.skip('Symlink creation unavailable');
          throw error;
        }
        const policy = options(root, 'skip.ts', 'node_modules/nonexistent');
        expect(await discoverSourceFiles(root, policy)).toEqual([join(root, 'real/index.ts')]);
        expect(await analyzeProject(root, policy)).toMatchObject({ missingDependencies: ['real'] });
        for (const name of ['linked', 'node_modules', 'dist'])
          expect(listings()).not.toContain(join(root, name));
      },
    );
  });
  it('preserves POSIX literal backslashes in discovered names instead of treating them as separators', async () => {
    if (process.platform === 'win32') return;
    await project(
      {
        'src\\generated/real.ts': "import 'literal-name';",
        'src/generated/ignored.ts': "import 'unterminated",
      },
      async (root) => {
        expect(await analyzeProject(root, options(root, 'src/generated'))).toMatchObject({
          missingDependencies: ['literal-name'],
        });
      },
    );
  });
  it('keeps casing literal and preserves invalid-source errors with empty or ineffective exclusions', async () => {
    await project({ 'src/generated/broken.ts': "import 'unterminated" }, async (root) => {
      for (const policy of [
        {},
        { ignorePaths: [] },
        options(root, 'src/Generated'),
        options(root, 'nonexistent'),
      ]) {
        await expect(analyzeProject(root, policy)).rejects.toThrow(join('src/generated/broken.ts'));
      }
      expect(await analyzeProject(root, options(root, 'src/generated'))).toMatchObject({
        missingDependencies: [],
      });
    });
  });
  it('keeps absent/empty/nonexistent options identical to the composed corrected baseline', async () => {
    const expected = await analyzeProject(baseline);
    expect(await analyzeProject(baseline, {})).toEqual(expected);
    expect(await analyzeProject(baseline, { ignorePaths: [] })).toEqual(expected);
    expect(await analyzeProject(baseline, options(baseline, 'nonexistent/path'))).toEqual(expected);
    expect(await discoverSourceFiles(baseline, { ignorePaths: [] })).toEqual(
      await discoverSourceFiles(baseline),
    );
  });
});
