import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type * as nodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../../src/cli/runCli.js';
import {
  isExactPackageRoot,
  normalizeIgnoreDependencies,
} from '../../../src/config/ignoreDependencies.js';
import {
  analyzeProjectDetailed,
  projectPackageExplanation,
  type DetailedAnalysisResult,
} from '../../../src/core/analyzeProject.js';
import { createScanContext } from '../../../src/core/scanContext.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFsPromises>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

async function temporaryProject(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'depvitals-explanation-')));
  try {
    for (const [file, text] of Object.entries(files)) await writeFile(join(root, file), text);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const files = {
  'package.json': JSON.stringify({
    dependencies: {
      used: '1',
      'prod-unused': '1',
      'dual-unused': '1',
      'excluded-used': '1',
      'excluded-unused': '1',
      CasePkg: '1',
      '@scope/pkg': '1',
      constructor: '1',
      'odd/name': '1',
    },
    devDependencies: { 'dev-unused': '1', 'dual-unused': '1' },
    peerDependencies: { 'peer-only': '1', 'peer-used': '1' },
    optionalDependencies: { 'optional-only': '1', 'optional-used': '1' },
  }),
  'a.cjs':
    "require('used'); require('excluded-used'); require('CasePkg'); require('@scope/pkg/sub'); require('peer-used'); require('optional-used'); require('missing'); require('excluded-missing'); require('fs');",
  'depvitals.config.json': JSON.stringify({
    ignoreDependencies: ['excluded-used', 'excluded-unused', 'excluded-missing', 'excluded-only'],
    ignorePaths: ['absent.cjs'],
  }),
};

let root = '';
let snapshot: DetailedAnalysisResult;
beforeAll(async () => {
  root = await temporaryProject(files);
  try {
    snapshot = await analyzeProjectDetailed(await createScanContext(root));
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    root = '';
    throw error;
  }
});
afterAll(async () => {
  if (root === '') return;
  try {
    for (const [file, text] of Object.entries(files))
      expect(await readFile(join(root, file), 'utf8')).toBe(text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe('completed exact-package explanation projection', () => {
  it.each([
    ['used', 'used', true, 0, [], [], []],
    ['prod-unused', 'unused', true, 1, ['prod-unused'], [], []],
    ['dev-unused', 'unused', true, 1, [], ['dev-unused'], []],
    ['dual-unused', 'unused', true, 1, ['dual-unused'], ['dual-unused'], []],
    ['missing', 'missing', true, 1, [], [], ['missing']],
    ['excluded-used', 'excluded', true, 0, [], [], []],
    ['excluded-unused', 'excluded', true, 0, [], [], []],
    ['excluded-missing', 'excluded', true, 0, [], [], []],
    ['excluded-only', 'excluded', true, 0, [], [], []],
    ['peer-only', 'declared', true, 0, [], [], []],
    ['optional-only', 'declared', true, 0, [], [], []],
    ['peer-used', 'used', true, 0, [], [], []],
    ['optional-used', 'used', true, 0, [], [], []],
    ['@scope/pkg', 'used', true, 0, [], [], []],
    ['CasePkg', 'used', true, 0, [], [], []],
    ['casepkg', 'unknown', false, 1, [], [], []],
    ['unknown', 'unknown', false, 1, [], [], []],
    ['fs', 'unknown', false, 1, [], [], []],
    ['constructor', 'unused', true, 1, ['constructor'], [], []],
  ] as const)(
    '%s has status %s, known=%s and exit %s',
    (name, status, known, exit, prod, dev, missing) => {
      const before = JSON.stringify(snapshot);
      const reads = vi.mocked(readFile).mock.calls.length;
      const result = projectPackageExplanation(snapshot, name);
      expect(result.query).toEqual({ packageName: name, known });
      expect(result.exitCode).toBe(exit);
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0].name).toBe(name);
      expect(result.packages[0].status).toBe(status);
      expect(result.findings).toEqual({
        unusedDependencies: prod,
        unusedDevDependencies: dev,
        missingDependencies: missing,
      });
      expect(result.counts).toEqual({
        unusedDependencies: prod.length,
        unusedDevDependencies: dev.length,
        missingDependencies: missing.length,
      });
      if (known)
        expect(result.packages[0]).toBe(snapshot.packages.find((pkg) => pkg.name === name));
      else
        expect(result.packages[0]).toEqual({
          name,
          status: 'unknown',
          declaredIn: [],
          excluded: false,
          underlyingFindings: [],
          findings: [],
          evidence: [],
        });
      expect(result.projectRoot).toBe(root);
      expect(result.config).toBe(snapshot.config);
      expect(vi.mocked(readFile).mock.calls.length).toBe(reads);
      expect(JSON.stringify(snapshot)).toBe(before);
    },
  );

  it('retains the full effective policy and underlying evidence for an excluded missing query', () => {
    const result = projectPackageExplanation(snapshot, 'excluded-missing');
    expect(result.config).toEqual({
      ignoreDependencies: ['excluded-missing', 'excluded-only', 'excluded-unused', 'excluded-used'],
      ignorePaths: ['absent.cjs'],
    });
    expect(result.packages[0]).toMatchObject({
      excluded: true,
      underlyingFindings: ['missingDependencies'],
      findings: [],
    });
    expect(result.packages[0].evidence).toHaveLength(1);
    expect(result.packages[0].evidence[0]).toMatchObject({
      kind: 'source',
      file: 'a.cjs',
      specifier: 'excluded-missing',
    });
    expect(snapshot.findings.missingDependencies).toEqual(['missing']);
    expect(snapshot.findings.unusedDependencies).toContain('odd/name');
    expect(projectPackageExplanation(snapshot, 'used').exitCode).toBe(0);
  });

  it('needs no surviving target files and never rescans to project a completed snapshot', async () => {
    const removedRoot = await temporaryProject({
      'package.json': '{"dependencies":{"retained":"1"}}',
    });
    let completed: DetailedAnalysisResult;
    try {
      completed = await analyzeProjectDetailed(await createScanContext(removedRoot));
    } finally {
      await rm(removedRoot, { recursive: true, force: true });
    }
    expect(projectPackageExplanation(completed, 'retained').findings.unusedDependencies).toEqual([
      'retained',
    ]);
    expect(projectPackageExplanation(completed, 'other').query.known).toBe(false);
  });

  it.each(['lexical', 'unreadable'] as const)(
    'does not reach projection after unrelated %s source failure',
    async (failure) => {
      const badRoot = await temporaryProject({
        'package.json': '{"dependencies":{"used":"1"}}',
        'a.cjs': "require('used');",
        'z.cjs': failure === 'lexical' ? '"unfinished' : 'void 0;',
      });
      const project = vi.fn(projectPackageExplanation);
      try {
        const context = await createScanContext(badRoot);
        if (failure === 'unreadable') {
          vi.mocked(readFile)
            .mockResolvedValueOnce("require('used');")
            .mockRejectedValueOnce(new Error('read denied'));
        }
        const scan = analyzeProjectDetailed(context).then((result) => project(result, 'used'));
        await expect(scan).rejects.toMatchObject({
          name: 'AnalysisError',
          code: failure === 'lexical' ? 'invalid-source' : 'unreadable-source',
        });
        await expect(scan).rejects.toThrow('z.cjs');
        expect(project).not.toHaveBeenCalled();
      } finally {
        await rm(badRoot, { recursive: true, force: true });
      }
    },
  );

  it('connects explanation and JSON flags to the completed package facts', async () => {
    const query = await runCli(['--explain', 'used', root], { cwd: root, version: '0.3.0' });
    expect(query.exitCode).toBe(0);
    expect(query.stderr).toBe('');
    expect(query.stdout).toContain('Package: used\nStatus: used\n');
    const scan = await runCli([root, '--format', 'json'], { cwd: root, version: '0.3.0' });
    expect(scan.exitCode).toBe(1);
    expect(scan.stderr).toBe('');
    expect(scan.stdout).toContain('"mode": "scan"');
  });
});

describe('shared exact-root query validation', () => {
  it.each([
    'pkg',
    'CasePkg',
    '@Scope/Name',
    'fs',
    'node',
    'a.b_c-d',
    'a'.repeat(214),
    '@a/' + 'b'.repeat(211),
  ])('accepts the exact identifier %s without normalization', (name) => {
    expect(isExactPackageRoot(name)).toBe(true);
    expect(normalizeIgnoreDependencies([name], 'policy.json')).toEqual([name]);
    expect(projectPackageExplanation(snapshot, name).query.packageName).toBe(name);
  });
  it.each([
    '',
    ' pkg',
    'pkg ',
    'pkg/subpath',
    '@scope/pkg/sub',
    'pkg@1',
    'pkg@latest',
    '*',
    'pkg*',
    '@scope',
    '@scope/',
    '/pkg',
    './pkg',
    '../pkg',
    '-pkg',
    '_pkg',
    '.pkg',
    'node:fs',
    'pkg\n',
    'pkg\r',
    'pkg\t',
    'pkg\u0000',
    'café',
    'pkg\\sub',
    'a'.repeat(215),
    '@a/' + 'b'.repeat(212),
  ])('rejects the invalid exact identifier %j in both consumers', (name) => {
    expect(isExactPackageRoot(name)).toBe(false);
    expect(() => normalizeIgnoreDependencies([name], 'policy.json')).toThrow(/exact package root/);
    expect(() => projectPackageExplanation(snapshot, name)).toThrow(
      new TypeError(
        'Invalid value for --explain: expected an exact package root (name or @scope/name), at most 214 characters.',
      ),
    );
  });
});
