import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeIgnoreDependencies } from '../../../src/config/ignoreDependencies.js';
import { analyzeProject, type AnalysisResult } from '../../../src/core/analyzeProject.js';
import { formatTerminalReport } from '../../../src/reporters/terminalReporter.js';
import { findPackageScriptUsage } from '../../../src/scanner/scriptUsage.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function project(
  manifest: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'depvitals-dependency-exclusions-'));
  const inputs = { 'package.json': JSON.stringify(manifest), ...files };
  try {
    for (const [name, text] of Object.entries(inputs)) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    await run(root);
    for (const [name, text] of Object.entries(inputs))
      expect(readFileSync(join(root, name), 'utf8')).toBe(text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function policy(
  root: string,
  ...names: string[]
): { readonly ignoreDependencies: readonly string[] } {
  return {
    ignoreDependencies: normalizeIgnoreDependencies(names, join(root, 'depvitals.config.json')),
  };
}

const baseline = fileURLToPath(
  new URL('../../fixtures/analysis/audit-fix-baseline', import.meta.url),
);

describe('exact dependency finding exclusions after classification', () => {
  it('suppresses selected unused production/dev/duplicate declarations and undeclared source packages only', async () => {
    await project(
      {
        dependencies: {
          chosen: '*',
          duplicate: '*',
          'remaining-prod': '*',
          'used-prod': '*',
          fs: '*',
        },
        devDependencies: { 'chosen-dev': '*', duplicate: '*', 'remaining-dev': '*' },
        peerDependencies: { peer: '*', 'unused-peer': '*' },
        optionalDependencies: { optional: '*', 'unused-optional': '*' },
      },
      {
        'index.ts':
          "import 'used-prod'; import 'chosen-missing/subpath'; import 'remaining-missing'; import 'peer'; import 'optional'; throw new Error('must never execute');",
      },
      async (root) => {
        const options = Object.freeze(
          policy(root, 'chosen', 'chosen-dev', 'duplicate', 'chosen-missing', 'fs'),
        );
        const normal = await analyzeProject(root);
        expect(normal).toEqual({
          projectRoot: root,
          unusedDependencies: ['chosen', 'duplicate', 'fs', 'remaining-prod'],
          unusedDevDependencies: ['chosen-dev', 'duplicate', 'remaining-dev'],
          missingDependencies: ['chosen-missing', 'remaining-missing'],
        });
        const result = await analyzeProject(root, options);
        expect(result).toEqual({
          projectRoot: root,
          unusedDependencies: ['remaining-prod'],
          unusedDevDependencies: ['remaining-dev'],
          missingDependencies: ['remaining-missing'],
        });
        expect(await analyzeProject(root, options)).toEqual(result);
        expect(await analyzeProject(root)).toEqual(normal);
        expect(Object.keys(result).sort()).toEqual([
          'missingDependencies',
          'projectRoot',
          'unusedDependencies',
          'unusedDevDependencies',
        ]);
        expect(options.ignoreDependencies).toEqual([
          'chosen',
          'chosen-dev',
          'chosen-missing',
          'duplicate',
          'fs',
        ]);
      },
    );
  });
  it('preserves exact case, prefixes and scopes in every finding group', async () => {
    const names = [
      'foo',
      'Foo',
      'foo-extra',
      '@scope/foo',
      '@scope/foo-extra',
      '@other/foo',
      'pkg_',
    ];
    const selected = ['foo', '@scope/foo', 'pkg_'];
    const remaining = ['@other/foo', '@scope/foo-extra', 'Foo', 'foo-extra'];
    for (const kind of ['dependencies', 'devDependencies', 'missing'] as const) {
      const manifest =
        kind === 'missing' ? {} : { [kind]: Object.fromEntries(names.map((name) => [name, '*'])) };
      const source = kind === 'missing' ? names.map((name) => `import '${name}';`).join('\n') : '';
      await project(manifest, { 'index.ts': source }, async (root) => {
        const result = await analyzeProject(root, policy(root, ...selected));
        const expected: AnalysisResult = {
          projectRoot: root,
          unusedDependencies: [],
          unusedDevDependencies: [],
          missingDependencies: [],
        };
        expect(result).toEqual({
          ...expected,
          [kind === 'dependencies'
            ? 'unusedDependencies'
            : kind === 'devDependencies'
              ? 'unusedDevDependencies'
              : 'missingDependencies']: remaining,
        });
      });
    }
  });
  it.each(['gulp', 'gulp-cli', 'both'] as const)(
    'preserves the declared gulp collision when excluding %s',
    async (selected) => {
      await project(
        {
          dependencies: { gulp: '*', 'gulp-cli': '*', unrelated: '*' },
          scripts: { build: 'gulp build' },
        },
        {},
        async (root) => {
          const names = selected === 'both' ? ['gulp', 'gulp-cli'] : [selected];
          expect([
            ...findPackageScriptUsage(
              { build: 'gulp build' },
              new Set(['gulp', 'gulp-cli', 'unrelated']),
            ),
          ]).toEqual(['gulp']);
          expect(await analyzeProject(root, policy(root, ...names))).toEqual({
            projectRoot: root,
            unusedDependencies: selected === 'gulp' ? ['gulp-cli', 'unrelated'] : ['unrelated'],
            unusedDevDependencies: [],
            missingDependencies: [],
          });
        },
      );
    },
  );
  it('keeps tool hints and source scope independent of dependency exclusions', async () => {
    await project(
      { dependencies: { 'hinted-only': '*', 'ignored-source': '*', unrelated: '*' } },
      {
        'generated/usage.ts': "import 'ignored-source'; import 'ignored-missing';",
        'retained.ts': "import 'selected-missing'; import 'genuine-missing';",
      },
      async (root) => {
        const hints = new Set(['hinted-only']);
        expect(
          await analyzeProject(root, {
            ...policy(root, 'selected-missing'),
            ignorePaths: ['generated'],
            configUsedNames: hints,
          }),
        ).toEqual({
          projectRoot: root,
          unusedDependencies: ['ignored-source', 'unrelated'],
          unusedDevDependencies: [],
          missingDependencies: ['genuine-missing'],
        });
        expect([...hints]).toEqual(['hinted-only']);
      },
    );
  });
  it('still parses retained source even when every potential finding is selected', async () => {
    await project(
      { dependencies: { chosen: '*' } },
      { 'broken.ts': "import 'chosen'; import 'unterminated" },
      async (root) => {
        for (const options of [
          {},
          { ignoreDependencies: [] },
          policy(root, 'chosen', 'unterminated'),
        ]) {
          await expect(analyzeProject(root, options)).rejects.toMatchObject({
            name: 'AnalysisError',
            code: 'invalid-source',
          });
        }
      },
    );
  });
  it('preserves a retained source I/O failure and its cause despite exclusions', async () => {
    await project(
      { dependencies: { chosen: '*' } },
      { 'index.ts': "import 'chosen';" },
      async (root) => {
        const actual = await vi.importActual<typeof fs>('node:fs/promises');
        const cause = Object.assign(new Error('EACCES source'), { code: 'EACCES' });
        const source = join(root, 'index.ts');
        vi.mocked(fs.readFile).mockImplementation((path, options) => {
          if (path === source) return Promise.reject(cause);
          return actual.readFile(path, options);
        });
        try {
          await expect(analyzeProject(root, policy(root, 'chosen'))).rejects.toMatchObject({
            name: 'AnalysisError',
            code: 'unreadable-source',
            cause,
          });
          expect(vi.mocked(fs.readFile).mock.calls.some(([path]) => path === source)).toBe(true);
        } finally {
          vi.mocked(fs.readFile).mockImplementation(actual.readFile);
        }
      },
    );
  });
  it('preserves corrected default findings, rendered bytes and sorting with empty/ineffective policy', async () => {
    const normal = await analyzeProject(baseline);
    for (const options of [{}, { ignoreDependencies: [] }, policy(baseline, 'never-mentioned')]) {
      const result = await analyzeProject(baseline, options);
      expect(result).toEqual(normal);
      expect(formatTerminalReport(result)).toBe(formatTerminalReport(normal));
    }
    const options = policy(baseline, 'unused-z', 'genuine-missing', 'eslint');
    const selected = new Set(options.ignoreDependencies);
    const result = await analyzeProject(baseline, options);
    expect(result).toEqual({
      projectRoot: normal.projectRoot,
      unusedDependencies: normal.unusedDependencies.filter((name) => !selected.has(name)),
      unusedDevDependencies: normal.unusedDevDependencies.filter((name) => !selected.has(name)),
      missingDependencies: normal.missingDependencies.filter((name) => !selected.has(name)),
    });
  });
});
