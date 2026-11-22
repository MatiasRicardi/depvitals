import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../../../src/cli/runCli.js';
import { readRootTsconfig } from '../../../src/config/readRootTsconfig.js';
import {
  analyzeProjectDetailed,
  projectPackageExplanation,
} from '../../../src/core/analyzeProject.js';
import { createScanContext } from '../../../src/core/scanContext.js';
import type { ConfigOccurrence } from '../../../src/core/evidence.js';
import { collectTypescriptConfigUsage } from '../../../src/detectors/typescriptConfig.js';
import type { JsonReport } from '../../../src/reporters/jsonReporter.js';

function occurrence(packageName: string, pointer: string, value: string): ConfigOccurrence {
  return {
    packageName,
    evidence: { kind: 'config', detector: 'typescript', file: 'tsconfig.json', pointer, value },
  };
}

describe('root TypeScript extends usage', () => {
  it.each([
    ['@Scope/_shared/Node-22/base.config.json', '@Scope/_shared'],
    ['@scope/-shared', '@scope/-shared'],
    ['base.json', 'base.json'],
    ['path', 'path'],
    ['shared/.../a_b', 'shared'],
    ['a'.repeat(214), 'a'.repeat(214)],
  ])('retains a declared scalar %s', (value, packageName) => {
    expect(
      collectTypescriptConfigUsage({ kind: 'usable', extends: value }, new Set([packageName])),
    ).toEqual([occurrence(packageName, '/extends', value)]);
  });

  it.each([
    'shared/',
    'shared//config',
    'shared/./base',
    'shared/sub/../base',
    'shared/sub\\config',
    'shared/sub config',
    'shared/config\n',
    'shared/config?x',
    'shared/config#x',
    'shared/config%20',
    'shared/config@next',
    'shared@1',
    'shared/ñ.json',
    './shared',
    '../shared',
    '/shared/config',
    '//host/shared',
    '\\\\server\\share\\tsconfig.json',
    'C:/shared/config',
    'C:shared',
    'https://shared/config',
    'node:path',
    '@scope',
    '@scope/shared//config',
    ' Shared',
    'Shared',
    'a'.repeat(215),
  ])('leaves unsupported or unmatched selector %j inert', (value) => {
    expect(
      collectTypescriptConfigUsage(
        { kind: 'usable', extends: value },
        new Set(['shared', '@scope/shared', 'path', 'C', 'a'.repeat(215)]),
      ),
    ).toEqual([]);
  });

  it('keeps original indices and repeated values beside ignored selectors', () => {
    const value = '@Scope/_shared/node.json';
    expect(
      collectTypescriptConfigUsage(
        { kind: 'usable', extends: ['./local', value, 'unknown', value, 'path'] },
        new Set(['@Scope/_shared', 'path']),
      ),
    ).toEqual([
      occurrence('@Scope/_shared', '/extends/1', value),
      occurrence('@Scope/_shared', '/extends/3', value),
      occurrence('path', '/extends/4', 'path'),
    ]);
  });

  it('produces no occurrence for absent, skipped or empty input', () => {
    const declared = new Set(['shared']);
    expect(collectTypescriptConfigUsage({ kind: 'absent' }, declared)).toEqual([]);
    expect(collectTypescriptConfigUsage({ kind: 'skipped' }, declared)).toEqual([]);
    expect(collectTypescriptConfigUsage({ kind: 'usable', extends: undefined }, declared)).toEqual(
      [],
    );
    expect(collectTypescriptConfigUsage({ kind: 'usable', extends: [] }, declared)).toEqual([]);
    expect(collectTypescriptConfigUsage({ kind: 'usable', extends: 'shared' }, new Set())).toEqual(
      [],
    );
  });

  it('uses the existing analysis handoff for overlaps, exclusions and sorted evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'depvitals-typescript-evidence-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          dependencies: { both: '1', nested: '1', secondary: '1' },
          devDependencies: { both: '2', path: '1', 'config-only': '1' },
          peerDependencies: { both: '3', peer: '1' },
          optionalDependencies: { both: '4', optional: '1' },
        }),
      );
      await writeFile(
        join(root, 'depvitals.config.json'),
        '{"ignorePaths":["tsconfig.json"],"ignoreDependencies":["path"]}',
      );
      const source = String.raw`{"\u0065xtends":["both/base.json","undeclared","pa\u0074h","both/base.json","peer","optional","config-only/base.json"],"references":[{"path":"./secondary.json"}],}`;
      await writeFile(join(root, 'tsconfig.json'), source);
      await writeFile(join(root, 'secondary.json'), '{"extends":"secondary"}');
      await mkdir(join(root, 'child'));
      await writeFile(join(root, 'child', 'tsconfig.json'), '{"extends":"nested"}');
      await writeFile(join(root, 'index.js'), "import 'both';\n");

      const cli = await runCli(['--format', 'json'], { cwd: root, version: '0.5.0' });
      expect(cli.exitCode).toBe(1);
      expect(cli.stderr).toBe('');
      const v2Report = JSON.parse(cli.stdout) as JsonReport;
      expect(v2Report).toMatchObject({
        schemaVersion: 2,
        findings: {
          unusedDependencies: ['nested', 'secondary'],
          unusedDevDependencies: [],
        },
      });
      expect(v2Report.packages.find(({ name }) => name === 'path')).toMatchObject({
        status: 'excluded',
        evidence: [occurrence('path', '/extends/2', 'path').evidence],
      });
      expect(v2Report.packages.find(({ name }) => name === 'peer')).toMatchObject({
        status: 'used',
        evidence: [occurrence('peer', '/extends/4', 'peer').evidence],
      });

      const context = await createScanContext(root);
      const config = await readRootTsconfig(context.manifest.root, context.rootEntries);
      const occurrences = collectTypescriptConfigUsage(
        config,
        context.manifest.declaredDependencyNames,
      );
      const report = await analyzeProjectDetailed({
        ...context,
        configEvidence: [...context.configEvidence, ...occurrences.toReversed(), ...occurrences],
      });
      expect(report.findings).toEqual({
        unusedDependencies: ['nested', 'secondary'],
        unusedDevDependencies: [],
        missingDependencies: [],
      });
      const [both] = projectPackageExplanation(report, 'both').packages;
      expect(both).toMatchObject({
        declaredIn: ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'],
        status: 'used',
        evidence: [
          { kind: 'source', file: 'index.js', specifier: 'both' },
          occurrence('both', '/extends/0', 'both/base.json').evidence,
          occurrence('both', '/extends/3', 'both/base.json').evidence,
        ],
      });
      const [path] = projectPackageExplanation(report, 'path').packages;
      expect(path).toMatchObject({
        status: 'excluded',
        underlyingFindings: [],
        evidence: [occurrence('path', '/extends/2', 'path').evidence],
      });
      expect(projectPackageExplanation(report, 'config-only').packages[0]).toMatchObject({
        status: 'used',
        evidence: [occurrence('config-only', '/extends/6', 'config-only/base.json').evidence],
      });
      expect(projectPackageExplanation(report, 'peer').packages[0].status).toBe('used');
      expect(projectPackageExplanation(report, 'optional').packages[0].status).toBe('used');
      expect(projectPackageExplanation(report, 'undeclared').query.known).toBe(false);
      expect(await readFile(join(root, 'tsconfig.json'), 'utf8')).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
