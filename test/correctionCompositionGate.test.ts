import { spawnSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ProjectConfig } from '../src/config/readProjectConfig.js';
import {
  analyzeProjectDetailed,
  projectAnalysisResult,
  type AnalysisFindings,
} from '../src/core/analyzeProject.js';
import type { Evidence, PackageFact } from '../src/core/evidence.js';
import { createScanContext } from '../src/core/scanContext.js';
import type { JsonReport } from '../src/reporters/jsonReporter.js';

const fixture = fileURLToPath(
  new URL('./fixtures/analysis/correction-composition/', import.meta.url),
);
const entry = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const configFile = 'depvitals.config.json';
const env = {
  ...process.env,
  DEPVITALS_NO_UPDATE_CHECK: '1',
  NODE_OPTIONS: undefined,
  NODE_PATH: undefined,
};
const version = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

const categories = ['unusedDependencies', 'unusedDevDependencies', 'missingDependencies'] as const;
const emptyPolicy = { ignorePaths: [], ignoreDependencies: [] };
const ignoredNames = ['blocked-preload', 'fixture-root', 'gulp', 'ignore-only', 'preload-only'];
const baseFindings: AnalysisFindings = {
  unusedDependencies: [],
  unusedDevDependencies: ['blocked-preload', 'gulp-cli', 'operand-decoy'],
  missingDependencies: ['fixture-root', 'missing-pruned'],
};
const prunedFindings: AnalysisFindings = {
  unusedDependencies: ['source-only'],
  unusedDevDependencies: ['blocked-preload', 'gulp-cli', 'operand-decoy'],
  missingDependencies: ['fixture-root'],
};

type Scenario = {
  name: string;
  policy?: ProjectConfig;
  prune?: boolean;
  barriers?: boolean;
  underlying: AnalysisFindings;
  visible: AnalysisFindings;
};

const scenarios: Scenario[] = [
  { name: 'absent policy', underlying: baseFindings, visible: baseFindings },
  { name: 'empty policy', policy: emptyPolicy, underlying: baseFindings, visible: baseFindings },
  {
    name: 'source path exclusion',
    policy: { ignorePaths: ['prunable.cjs'], ignoreDependencies: [] },
    prune: true,
    underlying: prunedFindings,
    visible: prunedFindings,
  },
  {
    name: 'dependency exclusion',
    policy: { ignorePaths: [], ignoreDependencies: ignoredNames },
    underlying: baseFindings,
    visible: {
      unusedDependencies: [],
      unusedDevDependencies: ['gulp-cli', 'operand-decoy'],
      missingDependencies: ['missing-pruned'],
    },
  },
  {
    name: 'both exclusions with ignored detector barriers',
    policy: {
      ignorePaths: ['eslint.config.js', 'jest.config.js', 'prunable.cjs'],
      ignoreDependencies: ignoredNames,
    },
    prune: true,
    barriers: true,
    underlying: {
      unusedDependencies: ['source-only'],
      unusedDevDependencies: ['blocked-preload', 'gulp-cli', 'operand-decoy', 'ts-jest'],
      missingDependencies: ['fixture-root'],
    },
    visible: {
      unusedDependencies: ['source-only'],
      unusedDevDependencies: ['gulp-cli', 'operand-decoy', 'ts-jest'],
      missingDependencies: [],
    },
  },
];

function source(file: string, specifier: string, offset: number, line: number): Evidence {
  return {
    kind: 'source',
    file,
    reference: 'require',
    specifier,
    position: { offset, line, column: 9 },
  };
}
function script(command: string, via: 'direct' | 'node-preload', occurrence: number): Evidence {
  return {
    kind: 'script',
    file: 'package.json',
    pointer: '/scripts/check~1preload~0',
    command,
    via,
    occurrence,
  };
}
function expectedPackages(s: Scenario): PackageFact[] {
  const packageFact = (
    name: string,
    status: PackageFact['status'],
    declaredIn: PackageFact['declaredIn'],
    evidence: readonly Evidence[] = [],
  ): PackageFact => {
    const excluded = s.policy?.ignoreDependencies.includes(name) ?? false;
    return {
      name,
      status: excluded ? 'excluded' : status,
      declaredIn,
      excluded,
      underlyingFindings: categories.filter((key) => s.underlying[key].includes(name)),
      findings: categories.filter((key) => s.visible[key].includes(name)),
      evidence,
    };
  };
  const dev = ['devDependencies'] as const;
  // Expected positions and ordinals are counted from the fixture text. The outer node events
  // consume ordinals 1 and 5. The rejected preload in the second Node segment consumes none.
  const react: Evidence[] = [
    source('index.cjs', 'eslint-plugin-react', 8, 1),
    source('index.cjs', 'eslint-plugin-react', 40, 2),
    script('eslint-plugin-react', 'node-preload', 3),
    script('eslint-plugin-react', 'node-preload', 4),
  ];
  if (!s.barriers) {
    react.push(
      {
        kind: 'config',
        file: '.ESLINTRC.JSON',
        pointer: '/plugins/0',
        value: 'react',
        detector: 'eslint',
      },
      {
        kind: 'config',
        file: '.ESLINTRC.JSON',
        pointer: '/plugins/1',
        value: 'react',
        detector: 'eslint',
      },
    );
  }
  return [
    packageFact('blocked-preload', 'unused', dev),
    packageFact('eslint-plugin-react', 'used', dev, react),
    packageFact(
      'fixture-root',
      'missing',
      [],
      [source('child/index.cjs', 'fixture-root/public', 34, 2)],
    ),
    packageFact('gulp', 'used', dev, [script('gulp', 'direct', 0), script('gulp', 'direct', 6)]),
    packageFact('gulp-cli', 'unused', dev),
    ...(s.policy?.ignoreDependencies.includes('ignore-only')
      ? [packageFact('ignore-only', 'excluded', [])]
      : []),
    ...(!s.prune
      ? [
          packageFact(
            'missing-pruned',
            'missing',
            [],
            [source('prunable.cjs', 'missing-pruned', 32, 2)],
          ),
        ]
      : []),
    packageFact('operand-decoy', 'unused', dev),
    packageFact('preload-only', 'used', dev, [script('preload-only/esm', 'node-preload', 2)]),
    packageFact(
      'source-only',
      s.prune ? 'unused' : 'used',
      ['dependencies'],
      s.prune ? [] : [source('prunable.cjs', 'source-only', 8, 1)],
    ),
    packageFact(
      'ts-jest',
      s.barriers ? 'unused' : 'used',
      dev,
      s.barriers
        ? []
        : [
            {
              kind: 'config',
              file: 'package.json',
              pointer: '/jest/preset',
              value: 'ts-jest',
              detector: 'jest',
            },
          ],
    ),
  ];
}

function snapshot(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .sort()
    .map((path) => {
      const file = join(root, path);
      return lstatSync(file).isFile() ? path + ':' + readFileSync(file, 'hex') : path;
    });
}
async function project(check: (root: string) => Promise<void>): Promise<void> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'depvitals-correction-composition-')));
  const root = join(scratch, 'selected project');
  try {
    cpSync(fixture, root, { recursive: true });
    await check(root);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
function cli(
  root: string,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [entry, root, ...args], {
    cwd: tmpdir(),
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function terminal(expected: AnalysisFindings): string {
  const labels = ['Unused dependencies', 'Unused devDependencies', 'Missing dependencies'];
  return (
    'DepVitals\n\n' +
    categories
      .flatMap((key, index) => {
        const names = expected[key];
        return names.length === 0
          ? []
          : [
              [
                (labels[index] ?? '') + ' (' + String(names.length) + ')',
                ...names.map((name) => '  ' + name),
              ].join('\n'),
            ];
      })
      .join('\n\n') +
    '\n'
  );
}

describe('F1 composition with the evidence and policy contracts', () => {
  it.each(scenarios)(
    'matches authored facts, scan outputs and query exits with $name',
    async (s) => {
      await project(async (root) => {
        if (s.policy !== undefined) writeFileSync(join(root, configFile), JSON.stringify(s.policy));
        if (s.barriers) {
          for (const path of ['eslint.config.js', 'jest.config.js']) {
            // These files block their legacy detector even though discovery excludes their contents.
            writeFileSync(join(root, path), "import 'unterminated");
          }
        }
        const before = snapshot(root);
        const expected = expectedPackages(s);
        const detailed = await analyzeProjectDetailed(await createScanContext(root));
        expect(detailed.underlyingFindings).toEqual(s.underlying);
        expect(detailed.packages).toEqual(expected);
        expect(projectAnalysisResult(detailed)).toEqual({ projectRoot: root, ...s.visible });
        expect(cli(root)).toEqual({ status: 1, stderr: '', stdout: terminal(s.visible) });
        const scan = cli(root, '--format', 'json');
        expect(scan.status).toBe(1);
        expect(scan.stderr).toBe('');
        const report = JSON.parse(scan.stdout) as JsonReport;
        expect(report).toMatchObject({
          mode: 'scan',
          query: null,
          project: { root },
          tool: { name: 'depvitals', version },
          scope: s.policy ?? emptyPolicy,
          findings: s.visible,
        });
        expect(report.packages).toEqual(expected);
        expect(report.counts).toEqual({
          unusedDependencies: s.visible.unusedDependencies.length,
          unusedDevDependencies: s.visible.unusedDevDependencies.length,
          missingDependencies: s.visible.missingDependencies.length,
        });

        const hasDependencyPolicy = (s.policy?.ignoreDependencies.length ?? 0) > 0;
        const queries = [
          ['preload-only', 0],
          ['gulp-cli', 1],
          ['fixture-root', hasDependencyPolicy ? 0 : 1],
          ['source-only', s.prune ? 1 : 0],
          ['ignore-only', hasDependencyPolicy ? 0 : 1],
        ] as const;
        for (const [name, exit] of queries) {
          const result = cli(root, '--explain', name, '--format', 'json');
          expect(result.status).toBe(exit);
          expect(result.stderr).toBe('');
          const doc = JSON.parse(result.stdout) as JsonReport;
          const fact = expected.find((candidate) => candidate.name === name);
          expect(doc.query).toEqual({ packageName: name, known: fact !== undefined });
          expect(doc.packages).toEqual([
            fact ?? {
              name,
              status: 'unknown',
              declaredIn: [],
              excluded: false,
              underlyingFindings: [],
              findings: [],
              evidence: [],
            },
          ]);
          const selected = Object.fromEntries(
            categories.map((key) => [key, s.visible[key].filter((pkg) => pkg === name)] as const),
          );
          expect(doc.findings).toEqual(selected);
          expect(doc.counts).toEqual(
            Object.fromEntries(Object.entries(selected).map(([key, names]) => [key, names.length])),
          );
        }

        const human = cli(root, '--explain', 'preload-only');
        expect(human.status).toBe(0);
        expect(human.stderr).toBe('');
        expect(human.stdout).toContain(
          'Package: preload-only\nStatus: ' + (hasDependencyPolicy ? 'excluded' : 'used') + '\n',
        );
        expect(human.stdout).toContain(
          '  script "package.json"#"/scripts/check~1preload~0" node-preload "preload-only/esm" (occurrence 2)\n',
        );
        expect(snapshot(root)).toEqual(before);
      });
    },
  );

  it.each(['prunable.cjs', '.ESLINTRC.JSON', configFile])(
    'keeps a fatal %s error visible with an ignored dependency',
    async (path) => {
      await project(async (root) => {
        writeFileSync(
          join(root, configFile),
          JSON.stringify({ ignoreDependencies: ['preload-only'] }),
        );
        const broken =
          path === 'prunable.cjs'
            ? "require('unterminated"
            : path === configFile
              ? '{"ignoreDependencies":["preload-only"],"ignorePaths":null}'
              : '{invalid';
        writeFileSync(join(root, path), broken);
        const before = snapshot(root);
        await expect(createScanContext(root).then(analyzeProjectDetailed)).rejects.toThrow(path);
        for (const args of [
          [],
          ['--format', 'json'],
          ['--explain', 'preload-only'],
          ['--explain', 'preload-only', '--format', 'json'],
        ]) {
          const result = cli(root, ...args);
          expect(result.status).toBe(1);
          expect(result.stdout).toBe('');
          expect(result.stderr).toContain(path);
        }
        expect(snapshot(root)).toEqual(before);
      });
    },
  );
});
