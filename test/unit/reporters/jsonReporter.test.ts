import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import type * as nodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../../src/cli/runCli.js';
import {
  analyzeProjectDetailed,
  projectPackageExplanation,
  type DetailedAnalysisResult,
  type PackageExplanation,
} from '../../../src/core/analyzeProject.js';
import type { Evidence, PackageFact } from '../../../src/core/evidence.js';
import { createScanContext } from '../../../src/core/scanContext.js';
import {
  createJsonReport,
  formatJsonReport,
  type JsonReport,
} from '../../../src/reporters/jsonReporter.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFsPromises>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    lstat: vi.fn(actual.lstat),
  };
});
const version = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const expectedScope = {
  sourceExtensions: ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'],
  excludedDirectories: [
    '.cache',
    '.git',
    '.next',
    '.nuxt',
    '.turbo',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'out',
  ],
  ignorePaths: [],
  ignoreDependencies: [],
};
async function project(
  manifest: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
  run: (root: string, result: DetailedAnalysisResult) => Promise<void> | void,
): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'depvitals-json-')));
  const inputs = { 'package.json': JSON.stringify(manifest), ...files };
  try {
    for (const [file, text] of Object.entries(inputs)) {
      await fs.mkdir(dirname(join(root, file)), { recursive: true });
      await fs.writeFile(join(root, file), text);
    }
    const result = await analyzeProjectDetailed(await createScanContext(root));
    await run(root, result);
    for (const [file, text] of Object.entries(inputs))
      expect(await fs.readFile(join(root, file), 'utf8')).toBe(text);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
function example(name: string, root: string): JsonReport {
  const expected = JSON.parse(
    readFileSync(new URL(`../../../schemas/examples/${name}.json`, import.meta.url), 'utf8'),
  ) as JsonReport;
  return { ...expected, tool: { name: 'depvitals', version }, project: { root } };
}
function freezeDeep(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) freezeDeep(item);
  Object.freeze(value);
}

const issueManifest = { dependencies: { unused: '1' }, devDependencies: { 'unused-tool': '1' } };
const issueFiles = { 'src/index.ts': "import item from 'missing';\n" };
describe('JSON report v1', () => {
  it.each([
    { name: 'scan-clean', manifest: {}, files: {}, query: null },
    { name: 'scan-findings', manifest: issueManifest, files: issueFiles, query: null },
    { name: 'explain-missing', manifest: issueManifest, files: issueFiles, query: 'missing' },
    {
      name: 'explain-excluded',
      manifest: { dependencies: { unused: '1' } },
      files: { 'depvitals.config.json': '{"ignoreDependencies":["unused"]}' },
      query: 'unused',
    },
    { name: 'explain-unknown', manifest: {}, files: {}, query: 'absent' },
  ])(
    'matches independent normative $name from real completed facts',
    async ({ name, manifest, files, query }) => {
      await project(manifest, files, (root, result) => {
        const input =
          query === null
            ? { mode: 'scan' as const, result }
            : { mode: 'explain' as const, result: projectPackageExplanation(result, query) };
        const expected = example(name, root);
        const reads = [
          vi.mocked(fs.readFile).mock.calls.length,
          vi.mocked(fs.readdir).mock.calls.length,
          vi.mocked(fs.lstat).mock.calls.length,
        ];
        expect(createJsonReport(input, version)).toEqual(expected);
        expect(formatJsonReport(input, version)).toBe(JSON.stringify(expected, null, 2) + '\n');
        expect([
          vi.mocked(fs.readFile).mock.calls.length,
          vi.mocked(fs.readdir).mock.calls.length,
          vi.mocked(fs.lstat).mock.calls.length,
        ]).toEqual(reads);
      });
    },
  );

  it('renders the normative Node-preload example from independently supplied facts', async () => {
    await project({}, {}, (root, base) => {
      const result: PackageExplanation = {
        projectRoot: root,
        config: base.config,
        findings: { unusedDependencies: [], unusedDevDependencies: [], missingDependencies: [] },
        counts: { unusedDependencies: 0, unusedDevDependencies: 0, missingDependencies: 0 },
        packages: [
          {
            name: 'preload',
            status: 'used',
            declaredIn: ['devDependencies'],
            excluded: false,
            underlyingFindings: [],
            findings: [],
            evidence: [
              {
                kind: 'script',
                file: 'package.json',
                pointer: '/scripts/check~1node~0',
                command: 'preload/esm',
                via: 'node-preload',
                occurrence: 2,
              },
              {
                kind: 'script',
                file: 'package.json',
                pointer: '/scripts/check~1node~0',
                command: 'preload/esm',
                via: 'node-preload',
                occurrence: 3,
              },
            ],
          },
        ],
        query: { packageName: 'preload', known: true },
        exitCode: 0,
      };
      expect(formatJsonReport({ mode: 'explain', result }, version)).toBe(
        JSON.stringify(example('explain-node-preload', root), null, 2) + '\n',
      );
    });
  });

  it('emits explicit keys in exact order while excluding internal and injected extra properties', async () => {
    await project({ dependencies: { unused: '1' } }, {}, (_root, base) => {
      const position = { offset: 8, line: 1, column: 9, secret: true };
      const fact: Evidence = {
        kind: 'source',
        file: 'src/a.cjs',
        reference: 'require',
        specifier: 'missing/sub',
        position,
      };
      const extraFact = { ...fact, hidden: 'no' };
      const pkg: PackageFact = {
        name: 'missing',
        status: 'missing',
        declaredIn: [],
        excluded: false,
        underlyingFindings: ['missingDependencies'],
        findings: ['missingDependencies'],
        evidence: [extraFact],
      };
      const result = {
        ...base,
        packages: [{ ...pkg, internal: 'no' }],
        privateMap: new Map([['hidden', true]]),
      };
      const document = createJsonReport({ mode: 'scan', result }, version);
      expect(Object.keys(document)).toEqual([
        'schemaVersion',
        'tool',
        'mode',
        'project',
        'scope',
        'findings',
        'counts',
        'packages',
        'query',
      ]);
      expect(Object.keys(document.scope)).toEqual([
        'sourceExtensions',
        'excludedDirectories',
        'ignorePaths',
        'ignoreDependencies',
      ]);
      expect(Object.keys(document.findings)).toEqual([
        'unusedDependencies',
        'unusedDevDependencies',
        'missingDependencies',
      ]);
      expect(Object.keys(document.counts)).toEqual([
        'unusedDependencies',
        'unusedDevDependencies',
        'missingDependencies',
      ]);
      expect(Object.keys(document.packages[0] ?? {})).toEqual([
        'name',
        'status',
        'declaredIn',
        'excluded',
        'underlyingFindings',
        'findings',
        'evidence',
      ]);
      const source = document.packages[0]?.evidence[0];
      expect(Object.keys(source ?? {})).toEqual([
        'kind',
        'file',
        'reference',
        'specifier',
        'position',
      ]);
      expect(source?.kind).toBe('source');
      if (source?.kind !== 'source') throw new Error('Expected source');
      expect(Object.keys(source.position)).toEqual(['offset', 'line', 'column']);
      const output = JSON.stringify(document);
      for (const key of [
        'manifest',
        'privateMap',
        'internal',
        'hidden',
        'secret',
        'declaredDependencyNames',
        'exitCode',
      ])
        expect(output).not.toContain('"' + key + '"');
    });
  });

  it('keeps independently sorted declarations, findings, policies and mixed evidence deterministic', async () => {
    await project({}, {}, (root, base) => {
      const evidence: Evidence[] = [
        {
          kind: 'config',
          file: 'package.json',
          pointer: '/jest/preset',
          value: 'example',
          detector: 'jest',
        },
        {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/check',
          command: 'example',
          via: 'runner',
          occurrence: 2,
        },
        {
          kind: 'source',
          file: 'src/A.cjs',
          reference: 'require',
          specifier: 'example/a',
          position: { offset: 8, line: 1, column: 9 },
        },
        {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/check',
          command: 'example',
          via: 'direct',
          occurrence: 0,
        },
        {
          kind: 'config',
          file: '.ESLINTRC.JSON',
          pointer: '/plugins/0',
          value: 'example',
          detector: 'eslint',
        },
      ];
      const packages: PackageFact[] = [
        {
          name: 'unused',
          status: 'unused',
          declaredIn: ['devDependencies', 'dependencies'],
          excluded: false,
          underlyingFindings: ['unusedDevDependencies', 'unusedDependencies'],
          findings: ['unusedDevDependencies', 'unusedDependencies'],
          evidence: [],
        },
        {
          name: 'example',
          status: 'used',
          declaredIn: [
            'optionalDependencies',
            'dependencies',
            'peerDependencies',
            'devDependencies',
          ],
          excluded: false,
          underlyingFindings: [],
          findings: [],
          evidence,
        },
      ];
      const result = {
        ...base,
        packages,
        config: { ignorePaths: ['z', 'A'], ignoreDependencies: ['z', 'a'] },
        findings: {
          unusedDependencies: ['unused'],
          unusedDevDependencies: ['unused'],
          missingDependencies: [],
        },
      };
      freezeDeep(result);
      const before = JSON.stringify(result);
      const doc = createJsonReport({ mode: 'scan', result }, '9.8.7-test');
      expect(doc.tool).toEqual({ name: 'depvitals', version: '9.8.7-test' });
      expect(doc.project).toEqual({ root });
      expect(doc.scope).toEqual({
        ...expectedScope,
        ignorePaths: ['A', 'z'],
        ignoreDependencies: ['a', 'z'],
      });
      expect(doc.counts).toEqual({
        unusedDependencies: 1,
        unusedDevDependencies: 1,
        missingDependencies: 0,
      });
      expect(doc.packages.map((pkg) => pkg.name)).toEqual(['example', 'unused']);
      expect(doc.packages[0]?.declaredIn).toEqual([
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]);
      expect(doc.packages[1]?.findings).toEqual(['unusedDependencies', 'unusedDevDependencies']);
      expect(doc.packages[0]?.evidence.map((item) => item.kind)).toEqual([
        'source',
        'script',
        'script',
        'config',
        'config',
      ]);
      expect(Object.keys(doc.packages[0]?.evidence[1] ?? {})).toEqual([
        'kind',
        'file',
        'pointer',
        'command',
        'via',
        'occurrence',
      ]);
      expect(Object.keys(doc.packages[0]?.evidence[3] ?? {})).toEqual([
        'kind',
        'file',
        'pointer',
        'value',
        'detector',
      ]);
      const reordered = {
        ...result,
        packages: [...packages]
          .reverse()
          .map((pkg) => ({ ...pkg, evidence: [...pkg.evidence].reverse() })),
      };
      expect(formatJsonReport({ mode: 'scan', result: reordered }, '9.8.7-test')).toBe(
        formatJsonReport({ mode: 'scan', result }, '9.8.7-test'),
      );
      expect(JSON.stringify(result)).toBe(before);
    });
  });

  it('round-trips raw controls, empty/unusual names, Unicode and platform/literal path characters', async () => {
    await project({}, {}, (_root, base) => {
      const name = 'é😀\u001b[2J\n';
      const result: DetailedAnalysisResult = {
        ...base,
        projectRoot: 'C:\\work\\é😀',
        findings: {
          unusedDependencies: [''],
          unusedDevDependencies: [],
          missingDependencies: [name],
        },
        packages: [
          {
            name,
            status: 'missing',
            declaredIn: [],
            excluded: false,
            underlyingFindings: ['missingDependencies'],
            findings: ['missingDependencies'],
            evidence: [
              {
                kind: 'source',
                file: 'Src/a\\b.cjs',
                reference: 'require',
                specifier: name + '/sub',
                position: { offset: 8, line: 1, column: 9 },
              },
            ],
          },
          {
            name: '',
            status: 'unused',
            declaredIn: ['dependencies'],
            excluded: false,
            underlyingFindings: ['unusedDependencies'],
            findings: ['unusedDependencies'],
            evidence: [],
          },
        ],
      };
      const text = formatJsonReport({ mode: 'scan', result }, version);
      const doc = JSON.parse(text) as JsonReport;
      expect(doc.project.root).toBe('C:\\work\\é😀');
      expect(doc.findings.unusedDependencies).toEqual(['']);
      expect(doc.packages.map((pkg) => pkg.name)).toEqual(['', name]);
      expect(doc.packages[1]?.evidence[0]).toMatchObject({
        file: 'Src/a\\b.cjs',
        specifier: name + '/sub',
      });
      expect(text).toContain('\\u001b[2J\\n');
      expect(text).not.toContain('\\\\u001b');
      expect(text.startsWith('{\n')).toBe(true);
      expect(text.endsWith('}\n')).toBe(true);
      expect(text.endsWith('\n\n')).toBe(false);
    });
  });

  it('never produces partial JSON after a later retained-source failure in both terminal and JSON modes', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'depvitals-json-failure-')));
    try {
      await fs.writeFile(join(root, 'package.json'), '{"dependencies":{"known":"1"}}');
      await fs.writeFile(join(root, 'a.cjs'), "require('known');");
      await fs.writeFile(join(root, 'z.cjs'), '"unfinished');
      const formatter = vi.fn(formatJsonReport);
      await expect(
        analyzeProjectDetailed(await createScanContext(root)).then((result) =>
          formatter({ mode: 'scan', result }, version),
        ),
      ).rejects.toMatchObject({ code: 'invalid-source' });
      expect(formatter).not.toHaveBeenCalled();
      for (const args of [[root], [root, '--format', 'json']]) {
        const result = await runCli(args, { cwd: root, version });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).not.toBe('');
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
