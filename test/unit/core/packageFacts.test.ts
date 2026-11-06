import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type * as nodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../../src/cli/runCli.js';
import {
  analyzeProject,
  analyzeProjectDetailed,
  analyzeProjectWithContext,
  projectAnalysisResult,
  type DetailedAnalysisResult,
} from '../../../src/core/analyzeProject.js';
import { createScanContext } from '../../../src/core/scanContext.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFsPromises>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
async function project(
  manifest: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'depvitals-package-facts-')));
  const inputs = { 'package.json': JSON.stringify(manifest), ...files };
  try {
    for (const [name, text] of Object.entries(inputs)) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), text);
    }
    await run(root);
    for (const [name, text] of Object.entries(inputs))
      expect(await readFile(join(root, name), 'utf8')).toBe(text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function record(
  result: DetailedAnalysisResult,
  name: string,
): DetailedAnalysisResult['packages'][number] {
  const found = result.packages.find((pkg) => pkg.name === name);
  if (found === undefined) throw new Error(`Missing package ${name}`);
  return found;
}

describe('complete package fact classification', () => {
  it('keeps group membership, real usage and pre/post policy findings distinct', async () => {
    const manifest = {
      dependencies: {
        all: '1',
        'dual-unused': '1',
        'source-used': '1',
        'script-used': '1',
        'ignored-unused': '1',
        'ignore-used': '1',
        CasePkg: '1',
        casepkg: '1',
        gulp: '1',
        'gulp-cli': '1',
      },
      devDependencies: {
        all: '2',
        'dual-unused': '2',
        'eslint-config-prettier': '1',
        'ts-jest': '1',
        'other-unused': '1',
      },
      peerDependencies: { all: '3', 'peer-declared': '1', 'peer-used': '1' },
      optionalDependencies: { all: '4', 'optional-declared': '1', 'optional-used': '1' },
      scripts: {
        'check/~': 'unknown-command && gulp && script-used && ignore-used && npx ts-jest',
      },
      eslintConfig: { extends: 'prettier' },
      jest: { preset: 'ts-jest' },
    };
    const source =
      "require('all/sub'); require('source-used'); require('peer-used'); require('optional-used'); require('missing/sub'); require('ignored-missing'); require('CasePkg'); require('source-used/other');";
    await project(
      manifest,
      {
        'index.cjs': source,
        'depvitals.config.json': JSON.stringify({
          ignoreDependencies: [
            'ignored-unused',
            'ignored-missing',
            'ignored-only',
            'ignore-used',
            'ignored-only',
          ],
        }),
      },
      async (root) => {
        const detail = await analyzeProjectDetailed(await createScanContext(root));
        expect(detail.projectRoot).toBe(root);
        expect(detail.config).toEqual({
          ignorePaths: [],
          ignoreDependencies: ['ignore-used', 'ignored-missing', 'ignored-only', 'ignored-unused'],
        });
        expect(detail.underlyingFindings).toEqual({
          unusedDependencies: ['casepkg', 'dual-unused', 'gulp-cli', 'ignored-unused'],
          unusedDevDependencies: ['dual-unused', 'other-unused'],
          missingDependencies: ['ignored-missing', 'missing'],
        });
        expect(detail.findings).toEqual({
          unusedDependencies: ['casepkg', 'dual-unused', 'gulp-cli'],
          unusedDevDependencies: ['dual-unused', 'other-unused'],
          missingDependencies: ['missing'],
        });
        expect(record(detail, 'all')).toMatchObject({
          status: 'used',
          declaredIn: [
            'dependencies',
            'devDependencies',
            'peerDependencies',
            'optionalDependencies',
          ],
          excluded: false,
          underlyingFindings: [],
          findings: [],
        });
        expect(record(detail, 'dual-unused')).toEqual({
          name: 'dual-unused',
          status: 'unused',
          declaredIn: ['dependencies', 'devDependencies'],
          excluded: false,
          underlyingFindings: ['unusedDependencies', 'unusedDevDependencies'],
          findings: ['unusedDependencies', 'unusedDevDependencies'],
          evidence: [],
        });
        for (const name of ['peer-declared', 'optional-declared'])
          expect(record(detail, name)).toMatchObject({
            status: 'declared',
            underlyingFindings: [],
            findings: [],
            evidence: [],
          });
        for (const name of ['peer-used', 'optional-used', 'CasePkg', 'source-used'])
          expect(record(detail, name).status).toBe('used');
        expect(record(detail, 'casepkg').status).toBe('unused');
        expect(record(detail, 'missing')).toMatchObject({
          status: 'missing',
          declaredIn: [],
          underlyingFindings: ['missingDependencies'],
          findings: ['missingDependencies'],
        });
        expect(record(detail, 'ignored-missing')).toMatchObject({
          status: 'excluded',
          excluded: true,
          underlyingFindings: ['missingDependencies'],
          findings: [],
        });
        expect(record(detail, 'ignored-missing').evidence).toHaveLength(1);
        expect(record(detail, 'ignored-unused')).toMatchObject({
          status: 'excluded',
          underlyingFindings: ['unusedDependencies'],
          findings: [],
          evidence: [],
        });
        expect(record(detail, 'ignore-used')).toMatchObject({
          status: 'excluded',
          underlyingFindings: [],
          findings: [],
        });
        expect(record(detail, 'ignore-used').evidence).toHaveLength(1);
        expect(record(detail, 'ignored-only')).toEqual({
          name: 'ignored-only',
          status: 'excluded',
          declaredIn: [],
          excluded: true,
          underlyingFindings: [],
          findings: [],
          evidence: [],
        });
        expect(record(detail, 'script-used').evidence).toEqual([
          {
            kind: 'script',
            file: 'package.json',
            pointer: '/scripts/check~1~0',
            command: 'script-used',
            via: 'direct',
            occurrence: 2,
          },
        ]);
        expect(record(detail, 'gulp').evidence).toEqual([
          {
            kind: 'script',
            file: 'package.json',
            pointer: '/scripts/check~1~0',
            command: 'gulp',
            via: 'direct',
            occurrence: 1,
          },
        ]);
        expect(record(detail, 'gulp-cli').evidence).toEqual([]);
        expect(record(detail, 'eslint-config-prettier').evidence).toEqual([
          {
            kind: 'config',
            file: 'package.json',
            pointer: '/eslintConfig/extends',
            value: 'prettier',
            detector: 'eslint',
          },
        ]);
        expect(record(detail, 'ts-jest').evidence.map(({ kind }) => kind)).toEqual([
          'script',
          'config',
        ]);
        expect(record(detail, 'source-used').evidence).toHaveLength(2);
        expect(
          detail.packages.some((pkg) => pkg.name === 'unknown-command' || pkg.status === 'unknown'),
        ).toBe(false);
        expect(detail.packages.map((pkg) => pkg.name)).toEqual([
          'CasePkg',
          'all',
          'casepkg',
          'dual-unused',
          'eslint-config-prettier',
          'gulp',
          'gulp-cli',
          'ignore-used',
          'ignored-missing',
          'ignored-only',
          'ignored-unused',
          'missing',
          'optional-declared',
          'optional-used',
          'other-unused',
          'peer-declared',
          'peer-used',
          'script-used',
          'source-used',
          'ts-jest',
        ]);
        expect(Object.keys(record(detail, 'all'))).toEqual([
          'name',
          'status',
          'declaredIn',
          'excluded',
          'underlyingFindings',
          'findings',
          'evidence',
        ]);
        expect(projectAnalysisResult(detail)).toEqual(
          await analyzeProjectWithContext(await createScanContext(root)),
        );
        expect(Object.keys(projectAnalysisResult(detail))).toEqual([
          'projectRoot',
          'unusedDependencies',
          'unusedDevDependencies',
          'missingDependencies',
        ]);
      },
    );
  });
  it('deduplicates exact facts without losing source positions, script ordinals or config pointers', async () => {
    await project(
      {
        devDependencies: { 'ts-jest': '1' },
        scripts: { check: 'ts-jest && ts-jest' },
        jest: { preset: 'ts-jest', transform: { key: 'ts-jest' } },
      },
      { 'Index.js': 'import "ts-jest"; require("ts-jest");' },
      async (root) => {
        const context = await createScanContext(root);
        const before = vi.mocked(readFile).mock.calls.length;
        const detail = await analyzeProjectDetailed({
          ...context,
          configEvidence: [...context.configEvidence, ...context.configEvidence],
        });
        expect(record(detail, 'ts-jest').evidence).toEqual([
          {
            kind: 'source',
            file: 'Index.js',
            reference: 'import',
            specifier: 'ts-jest',
            position: { offset: 7, line: 1, column: 8 },
          },
          {
            kind: 'source',
            file: 'Index.js',
            reference: 'require',
            specifier: 'ts-jest',
            position: { offset: 26, line: 1, column: 27 },
          },
          {
            kind: 'script',
            file: 'package.json',
            pointer: '/scripts/check',
            command: 'ts-jest',
            via: 'direct',
            occurrence: 0,
          },
          {
            kind: 'script',
            file: 'package.json',
            pointer: '/scripts/check',
            command: 'ts-jest',
            via: 'direct',
            occurrence: 1,
          },
          {
            kind: 'config',
            file: 'package.json',
            pointer: '/jest/preset',
            value: 'ts-jest',
            detector: 'jest',
          },
          {
            kind: 'config',
            file: 'package.json',
            pointer: '/jest/transform/key',
            value: 'ts-jest',
            detector: 'jest',
          },
        ]);
        expect(
          vi
            .mocked(readFile)
            .mock.calls.slice(before)
            .map(([path]) => path),
        ).toEqual([join(root, 'Index.js')]);
        const count = vi.mocked(readFile).mock.calls.length;
        projectAnalysisResult(detail);
        projectAnalysisResult(detail);
        expect(vi.mocked(readFile).mock.calls.length).toBe(count);
      },
    );
  });
  it('retains case-sensitive, empty, numeric and prototype-like declaration identities', async () => {
    const dependencies = JSON.parse(
      '{"__proto__":"1","constructor":"1","":"1","CasePkg":"1","casepkg":"1","2":"1","10":"1"}',
    ) as Record<string, string>;
    await project(
      { dependencies },
      { 'index.cjs': "require('CasePkg'); require('__proto__');" },
      async (root) => {
        const detail = await analyzeProjectDetailed(await createScanContext(root));
        expect(detail.packages.map((pkg) => pkg.name)).toEqual([
          '',
          '10',
          '2',
          'CasePkg',
          '__proto__',
          'casepkg',
          'constructor',
        ]);
        expect(record(detail, '').status).toBe('unused');
        expect(record(detail, '__proto__').status).toBe('used');
        expect(record(detail, 'constructor').declaredIn).toEqual(['dependencies']);
        expect(detail.packages.some((pkg) => pkg.name === 'toString')).toBe(false);
        expect(detail.findings.unusedDependencies).toEqual([
          '',
          '10',
          '2',
          'casepkg',
          'constructor',
        ]);
      },
    );
  });
  it('applies exact nearest-scope self exports before retaining normalized external subpaths', async () => {
    await project(
      { name: 'owner', exports: { '.': './entry.cjs', './feature': './feature.cjs' } },
      {
        'entry.cjs':
          "require('owner'); require('owner/feature'); require('owner/private'); require('fs'); require('./local');",
        'child/package.json': JSON.stringify({
          name: 'child',
          exports: './a.cjs',
          dependencies: { 'nested-only': '1', 'child-only': '1' },
        }),
        'child/a.cjs': "require('child'); require('owner'); require('nested-only');",
      },
      async (root) => {
        const detail = await analyzeProjectDetailed(await createScanContext(root));
        expect(detail.packages.map((pkg) => pkg.name)).toEqual(['nested-only', 'owner']);
        expect(record(detail, 'owner').status).toBe('missing');
        expect(
          record(detail, 'owner').evidence.map((fact) =>
            fact.kind === 'source' ? [fact.file, fact.specifier] : [],
          ),
        ).toEqual([
          ['child/a.cjs', 'owner'],
          ['entry.cjs', 'owner/private'],
        ]);
        expect(detail.findings.missingDependencies).toEqual(['nested-only', 'owner']);
      },
    );
  });
  it('serializes native paths without rewriting POSIX literal backslashes', async () => {
    const file = process.platform === 'win32' ? 'Src/Thing.cjs' : 'Src/a\\Thing.cjs';
    await project(
      {},
      { [file]: "require('@scope/pkg/a'); require('@scope/pkg/b');" },
      async (root) => {
        const detail = await analyzeProjectDetailed(await createScanContext(root));
        expect(record(detail, '@scope/pkg').evidence).toEqual([
          {
            kind: 'source',
            file,
            reference: 'require',
            specifier: '@scope/pkg/a',
            position: { offset: 8, line: 1, column: 9 },
          },
          {
            kind: 'source',
            file,
            reference: 'require',
            specifier: '@scope/pkg/b',
            position: { offset: 33, line: 1, column: 34 },
          },
        ]);
      },
    );
  });
  it('source exclusions remove actual use without creating policy evidence', async () => {
    await project(
      { dependencies: { candidate: '1' } },
      {
        'skip.cjs': "require('candidate'); require('hidden-missing');",
        'depvitals.config.json': '{"ignorePaths":["skip.cjs"]}',
      },
      async (root) => {
        const start = vi.mocked(readFile).mock.calls.length;
        const detail = await analyzeProjectDetailed(await createScanContext(root));
        expect(record(detail, 'candidate')).toEqual({
          name: 'candidate',
          status: 'unused',
          declaredIn: ['dependencies'],
          excluded: false,
          underlyingFindings: ['unusedDependencies'],
          findings: ['unusedDependencies'],
          evidence: [],
        });
        expect(detail.packages.some((pkg) => pkg.name === 'hidden-missing')).toBe(false);
        expect(
          vi
            .mocked(readFile)
            .mock.calls.slice(start)
            .map(([path]) => path),
        ).not.toContain(join(root, 'skip.cjs'));
      },
    );
  });
  it('preserves legacy names-only hint findings without manufacturing detailed usage records', async () => {
    await project({ dependencies: { candidate: '1' } }, {}, async (root) => {
      const legacy = await analyzeProject(root, { configUsedNames: new Set(['candidate']) });
      expect(legacy.unusedDependencies).toEqual([]);
      expect(Object.keys(legacy)).toEqual([
        'projectRoot',
        'unusedDependencies',
        'unusedDevDependencies',
        'missingDependencies',
      ]);
      const detail = await analyzeProjectDetailed(await createScanContext(root));
      expect(record(detail, 'candidate').status).toBe('unused');
      expect(record(detail, 'candidate').evidence).toEqual([]);
    });
  });
  it('never enlarges missing or inventory with undeclared config-only hints', async () => {
    await project({}, {}, async (root) => {
      const context = await createScanContext(root);
      const detail = await analyzeProjectDetailed({
        ...context,
        configEvidence: [
          {
            packageName: 'undeclared',
            evidence: {
              kind: 'config',
              file: 'package.json',
              pointer: '/jest/preset',
              value: 'undeclared',
              detector: 'jest',
            },
          },
        ],
      });
      expect(detail.packages).toEqual([]);
      expect(detail.findings.missingDependencies).toEqual([]);
    });
  });
  it('does not return a partial snapshot when a later retained source is invalid', async () => {
    await project(
      { dependencies: { known: '1' } },
      { 'a.cjs': "require('known');", 'z.cjs': '"unfinished' },
      async (root) => {
        await expect(analyzeProjectDetailed(await createScanContext(root))).rejects.toMatchObject({
          name: 'AnalysisError',
          code: 'invalid-source',
        });
        const result = await runCli([root], { cwd: root, version: '0.3.0' });
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('z.cjs');
        expect(result.exitCode).toBe(1);
      },
    );
  });
});
