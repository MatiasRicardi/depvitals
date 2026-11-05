import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Snapshot = { sha256: string; entries: Record<string, unknown>[] };
type ToolIdentity = { version: string; sourceSha: string; build: Snapshot };
type Entry = {
  id: string;
  upstream: string;
  commit: string;
  selectedRoot: string;
  snapshot: Snapshot;
  expectationStatus: string;
  scope: { mode: string; overlays: string[] };
};
type Catalog = { catalogVersion: number; projects: Entry[] };
type Input = {
  catalog: Catalog;
  roots: Record<string, string>;
  toolRoot: string;
  toolIdentity: ToolIdentity;
};
type Result = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};
type Runner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
) => Result;
type BaselineReview = {
  reviewVersion: number;
  status: string;
  reviewedBy: { primary: string; independent: string };
  toolVersion: string;
  sourceSnapshotSha256: string;
  catalogSha256: string;
  projects: {
    id: string;
    currentContractExpected: {
      unusedDependencies: string[];
      unusedDevDependencies: string[];
      missingDependencies: string[];
    };
    expectedProcess: { status: number; stdout: string; stderr: string };
  }[];
};
type Receipt = {
  tool: { version: string; source: Snapshot };
  catalogSha256: string;
  expectationsReviewed: boolean;
  observations: {
    id: string;
    status: number;
    stdout: string;
    stderr: string;
    nonMutationVerified: boolean;
  }[];
};
const { identifySnapshot, identifyTool, evaluateCorpus, verifyReviewedBaseline } = (await import(
  new URL('../scripts/evaluate-corpus.mjs', import.meta.url).href
)) as {
  verifyReviewedBaseline: (receipt: Receipt, review: BaselineReview) => { matched: boolean };
  identifySnapshot: (root: string) => Snapshot;
  identifyTool: (root: string, sha: string) => ToolIdentity;
  evaluateCorpus: (input: Input, execute?: Runner) => Receipt;
};
const toolRoot = resolve(import.meta.dirname, '..');
const sourceSha = '8054e079aa2e2e40d3f1f41e5b2e35b4d2c7db7f';
let scratch: string;
let project: string;
function input(): Input {
  return {
    catalog: {
      catalogVersion: 1,
      projects: [
        {
          id: 'authored-control',
          upstream: 'https://github.com/example/authored-control',
          commit: 'a'.repeat(40),
          selectedRoot: '.',
          snapshot: identifySnapshot(project),
          expectationStatus: 'NOT REVIEWED',
          scope: { mode: 'upstream-default', overlays: [] },
        },
      ],
    },
    roots: { 'authored-control': project },
    toolRoot,
    toolIdentity: identifyTool(toolRoot, sourceSha),
  };
}
function runner(onScan: () => Result): Runner {
  return (_command, args, options) => {
    expect(options.env['CI']).toBe('1');
    expect(options.env['DEPVITALS_NO_UPDATE_CHECK']).toBe('1');
    expect(options.env['NODE_OPTIONS']).toBeUndefined();
    expect(options.timeout).toBe(30000);
    expect(args[0]).toBe(join(toolRoot, 'dist/cli/index.js'));
    if (args[1] === '--version') return { status: 0, signal: null, stdout: '0.3.0\n', stderr: '' };
    expect(args).toEqual([join(toolRoot, 'dist/cli/index.js'), project]);
    return onScan();
  };
}
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'depvitals-corpus-control-')));
  project = join(scratch, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), '{}');
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function reviewedClean(receipt: Receipt): BaselineReview {
  return {
    reviewVersion: 1,
    status: 'REVIEWED',
    reviewedBy: { primary: 'authored primary', independent: 'authored independent' },
    toolVersion: receipt.tool.version,
    sourceSnapshotSha256: receipt.tool.source.sha256,
    catalogSha256: receipt.catalogSha256,
    projects: [
      {
        id: 'authored-control',
        currentContractExpected: {
          unusedDependencies: [],
          unusedDevDependencies: [],
          missingDependencies: [],
        },
        expectedProcess: {
          status: 0,
          stdout: 'DepVitals\n\nNo dependency issues found.\n',
          stderr: '',
        },
      },
    ],
  };
}

describe('offline external corpus identities', () => {
  it('captures actual clean/findings/error channels through the built CLI without running target code', () => {
    const marker = join(scratch, 'target-executed');
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({
        dependencies: { 'corpus-unused-only': '*' },
        scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}','ran')"` },
      }),
    );
    writeFileSync(
      join(project, 'index.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nrequire('corpus-missing-only');\n`,
    );
    writeFileSync(
      join(project, 'eslint.config.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'config ran');`,
    );
    let result = evaluateCorpus(input());
    expect(result.expectationsReviewed).toBe(false);
    expect(result.observations[0]).toMatchObject({
      status: 1,
      stderr: '',
      nonMutationVerified: true,
    });
    expect(result.observations[0]?.stdout).toContain('corpus-unused-only');
    expect(result.observations[0]?.stdout).toContain('corpus-missing-only');
    expect(existsSync(marker)).toBe(false);
    rmSync(join(project, 'index.cjs'));
    rmSync(join(project, 'eslint.config.cjs'));
    writeFileSync(join(project, 'package.json'), '{}');
    result = evaluateCorpus(input());
    expect(result.observations[0]).toMatchObject({ status: 0, stderr: '' });
    writeFileSync(join(project, 'package.json'), '{');
    result = evaluateCorpus(input());
    expect(result.observations[0]).toMatchObject({ status: 1, stdout: '' });
    expect(result.observations[0]?.stderr).toContain('not valid JSON');
    expect(existsSync(marker)).toBe(false);
  });

  it.each(['bytes', 'added-file', 'removed-file', 'directory', 'barrier', 'scope'])(
    'rejects changed %s before executing the CLI',
    (change) => {
      const args = input();
      if (change === 'bytes') writeFileSync(join(project, 'package.json'), '{"name":"changed"}');
      if (change === 'added-file') writeFileSync(join(project, 'new.js'), '');
      if (change === 'removed-file') rmSync(join(project, 'package.json'));
      if (change === 'directory') mkdirSync(join(project, 'empty-new-directory'));
      if (change === 'barrier') mkdirSync(join(project, 'eslint.config.js'));
      if (change === 'scope')
        writeFileSync(join(project, 'depvitals.config.json'), '{"ignorePaths":["src"]}');
      let calls = 0;
      expect(() =>
        evaluateCorpus(
          args,
          runner(() => {
            calls++;
            return { status: 0, signal: null, stdout: 'clean', stderr: '' };
          }),
        ),
      ).toThrow('Input identity changed');
      expect(calls).toBe(0);
    },
  );

  it('fails on missing or moved roots instead of fetching or guessing a nearby project', () => {
    const args = input();
    renameSync(project, join(scratch, 'moved'));
    expect(() => evaluateCorpus(args)).toThrow();
  });

  it('rejects a nested workspace path substituted for the selected root', () => {
    const args = input();
    mkdirSync(join(project, 'packages'));
    mkdirSync(join(project, 'packages', 'member'));
    writeFileSync(
      join(project, 'packages', 'member', 'package.json'),
      '{"name":"distinct-workspace-member"}',
    );
    args.roots['authored-control'] = join(project, 'packages', 'member');
    expect(() => evaluateCorpus(args)).toThrow('Input identity changed');
  });

  it('rejects stale build bytes before invoking the CLI', () => {
    const args = input();
    args.toolIdentity.build.sha256 = '0'.repeat(64);
    expect(() => evaluateCorpus(args)).toThrow('Tool source/build identity changed');
  });

  it.each([
    'scope',
    'duplicate',
    'corrupt-inventory',
    'relative-root',
    'partial-roots',
    'escape-root',
  ])('rejects invalid catalog/root input: %s', (change) => {
    const args = input();
    const entry = args.catalog.projects[0];
    if (!entry) throw new Error('fixture');
    if (change === 'scope') entry.scope.overlays.push('hidden overlay');
    if (change === 'duplicate') args.catalog.projects.push(entry);
    if (change === 'corrupt-inventory')
      entry.snapshot.entries.push({ path: 'invented', kind: 'directory' });
    if (change === 'relative-root') args.roots['authored-control'] = '.';
    if (change === 'partial-roots') args.roots = {};
    if (change === 'escape-root') entry.selectedRoot = '../other';
    expect(() => evaluateCorpus(args)).toThrow();
  });

  it.each([null, 2])(
    'does not accept an incomplete child exit (%s) as a clean observation',
    (status) => {
      expect(() =>
        evaluateCorpus(
          input(),
          runner(() => ({
            status,
            signal: status === null ? 'SIGTERM' : null,
            stdout: '',
            stderr: '',
          })),
        ),
      ).toThrow('CLI did not complete');
    },
  );

  it('detects scanner mutation even when the child has an operational error', () => {
    expect(() =>
      evaluateCorpus(
        input(),
        runner(() => {
          writeFileSync(join(project, 'changed-by-child'), 'bad');
          return { status: 1, signal: null, stdout: '', stderr: 'failed' };
        }),
      ),
    ).toThrow('Input identity changed');
  });

  it('preserves a completed operational diagnostic verbatim without generating expected findings', () => {
    const result = evaluateCorpus(
      input(),
      runner(() => ({
        status: 1,
        signal: null,
        stdout: '',
        stderr: 'independent operational diagnostic\n',
      })),
    );
    expect(result.observations[0]?.stderr).toBe('independent operational diagnostic\n');
    expect(result.expectationsReviewed).toBe(false);
    expect(result.observations[0]).not.toHaveProperty('expected');
  });

  it('matches separately authored reviewed process/findings while leaving raw observations unreviewed', () => {
    const receipt = evaluateCorpus(input());
    expect(verifyReviewedBaseline(receipt, reviewedClean(receipt)).matched).toBe(true);
    expect(receipt.expectationsReviewed).toBe(false);
  });

  it.each([
    'draft',
    'reviewer',
    'source',
    'corpus',
    'version',
    'process',
    'arrays',
    'duplicate',
    'missing',
    'mutation',
  ])('rejects invalid independent baseline review: %s', (change) => {
    const receipt = evaluateCorpus(input());
    const review = reviewedClean(receipt);
    const entry = review.projects[0];
    if (!entry) throw new Error('fixture');
    if (change === 'draft') review.status = 'DRAFT';
    if (change === 'reviewer') review.reviewedBy.independent = review.reviewedBy.primary;
    if (change === 'source') review.sourceSnapshotSha256 = '0'.repeat(64);
    if (change === 'corpus') review.catalogSha256 = '0'.repeat(64);
    if (change === 'version') review.toolVersion = '9.9.9';
    if (change === 'process') entry.expectedProcess.status = 1;
    if (change === 'arrays')
      entry.currentContractExpected.unusedDependencies.push('independent-decoy');
    if (change === 'duplicate') review.projects.push(entry);
    if (change === 'missing') review.projects = [];
    if (change === 'mutation') {
      const observation = receipt.observations[0];
      if (observation) observation.nonMutationVerified = false;
    }
    expect(() => verifyReviewedBaseline(receipt, review)).toThrow();
  });

  it('matches independent finding arrays and rejects report counts that disagree with the reviewed names', () => {
    const receipt = evaluateCorpus(
      input(),
      runner(() => ({
        status: 1,
        signal: null,
        stdout: 'DepVitals\n\nMissing dependencies (1)\n  report-missing\n',
        stderr: '',
      })),
    );
    const review = reviewedClean(receipt);
    const entry = review.projects[0];
    if (!entry) throw new Error('fixture');
    entry.expectedProcess = {
      status: 1,
      stdout: 'DepVitals\n\nMissing dependencies (1)\n  report-missing\n',
      stderr: '',
    };
    entry.currentContractExpected.missingDependencies = ['report-missing'];
    expect(verifyReviewedBaseline(receipt, review).matched).toBe(true);
    const observation = receipt.observations[0];
    if (!observation) throw new Error('fixture');
    observation.stdout = 'DepVitals\n\nMissing dependencies (2)\n  report-missing\n';
    entry.expectedProcess.stdout = observation.stdout;
    expect(() => verifyReviewedBaseline(receipt, review)).toThrow('Invalid baseline count');
  });

  it.each([
    'DepVitals\n',
    'DepVitals',
    'DepVitals\n\nUnused dependencies (0)\n',
    'DepVitals\n\nUnused dependencies (1)\n  missing-final-lf',
  ])('rejects incomplete or non-canonical reviewed baseline reports: %j', (stdout) => {
    const receipt = evaluateCorpus(input());
    const review = reviewedClean(receipt);
    const observation = receipt.observations[0],
      entry = review.projects[0];
    if (!observation || !entry) throw new Error('fixture');
    observation.stdout = stdout;
    entry.expectedProcess.stdout = stdout;
    if (stdout.includes('missing-final-lf'))
      entry.currentContractExpected.unusedDependencies = ['missing-final-lf'];
    expect(() => verifyReviewedBaseline(receipt, review)).toThrow();
  });

  it('CLI accepts a complete review and refuses to write a successful receipt for changed expectations', () => {
    const receipt = evaluateCorpus(input());
    const review = reviewedClean(receipt);
    const args = input();
    const catalog = join(scratch, 'catalog.json'),
      roots = join(scratch, 'roots.json'),
      tool = join(scratch, 'tool.json'),
      reviewFile = join(scratch, 'review.json');
    for (const [path, value] of [
      [catalog, args.catalog],
      [roots, args.roots],
      [tool, args.toolIdentity],
      [reviewFile, review],
    ] as const)
      writeFileSync(path, JSON.stringify(value));
    const invoke = (output: string): ReturnType<typeof spawnSync> =>
      spawnSync(
        process.execPath,
        [
          join(toolRoot, 'scripts/evaluate-corpus.mjs'),
          '--manifest',
          catalog,
          '--roots',
          roots,
          '--tool-root',
          toolRoot,
          '--tool-identity',
          tool,
          '--output',
          output,
          '--reviewed-baseline',
          reviewFile,
        ],
        { encoding: 'utf8', timeout: 10000 },
      );
    const output = join(scratch, 'reviewed-receipt.json');
    expect(invoke(output).status).toBe(0);
    expect((JSON.parse(readFileSync(output, 'utf8')) as Receipt).expectationsReviewed).toBe(true);
    review.status = 'DRAFT';
    writeFileSync(reviewFile, JSON.stringify(review));
    const invalid = join(scratch, 'invalid-receipt.json');
    expect(invoke(invalid).status).toBe(1);
    expect(existsSync(invalid)).toBe(false);
  });

  it('rejects installed packages without descending into node_modules', () => {
    mkdirSync(join(project, 'node_modules'));
    expect(() => identifySnapshot(project)).toThrow('without .git/node_modules');
  });

  it.skipIf(process.platform === 'win32')(
    'hashes symlink target text without following external links',
    () => {
      const external = join(scratch, 'external');
      writeFileSync(external, 'first');
      symlinkSync(external, join(project, 'linked.js'));
      const before = identifySnapshot(project);
      writeFileSync(external, 'second');
      expect(identifySnapshot(project)).toEqual(before);
      rmSync(join(project, 'linked.js'));
      symlinkSync('elsewhere', join(project, 'linked.js'));
      expect(identifySnapshot(project).sha256).not.toBe(before.sha256);
    },
  );

  it.skipIf(process.platform === 'win32')('rejects project and ancestor symlinks', () => {
    const linkedProject = join(scratch, 'linked-project');
    symlinkSync(project, linkedProject);
    expect(() => identifySnapshot(linkedProject)).toThrow('real directory');
    const linkedParent = join(scratch, 'linked-parent');
    symlinkSync(scratch, linkedParent);
    expect(() => identifySnapshot(join(linkedParent, 'project'))).toThrow(
      'must not traverse symlinks',
    );
    const args = input();
    args.roots['authored-control'] = join(linkedParent, 'project');
    expect(() => evaluateCorpus(args)).toThrow('must not traverse symlinks');
  });

  it.skipIf(process.platform !== 'darwin').each(['/tmp', '/var/tmp'])(
    'accepts macOS system aliases for acquired roots and CLI output under %s',
    (base) => {
      const alias = mkdtempSync(join(base, 'depvitals-corpus-system-alias-'));
      const canonical = realpathSync(alias);
      try {
        project = join(canonical, 'project');
        mkdirSync(project);
        writeFileSync(join(project, 'package.json'), '{}');
        expect(identifySnapshot(join(alias, 'project'))).toEqual(identifySnapshot(project));
        const args = input();
        args.roots['authored-control'] = join(alias, 'project');
        expect(evaluateCorpus(args).observations[0]).toMatchObject({
          status: 0,
          nonMutationVerified: true,
        });
        const catalog = join(canonical, 'catalog.json');
        const roots = join(canonical, 'roots.json');
        const tool = join(canonical, 'tool.json');
        for (const [path, value] of [
          [catalog, args.catalog],
          [roots, args.roots],
          [tool, args.toolIdentity],
        ] as const)
          writeFileSync(path, JSON.stringify(value));
        const invoke = (output: string): ReturnType<typeof spawnSync> =>
          spawnSync(
            process.execPath,
            [
              join(toolRoot, 'scripts/evaluate-corpus.mjs'),
              '--manifest',
              catalog,
              '--roots',
              roots,
              '--tool-root',
              toolRoot,
              '--tool-identity',
              tool,
              '--output',
              output,
            ],
            { encoding: 'utf8', timeout: 10000 },
          );
        const output = join(alias, 'receipt.json');
        expect(invoke(output).status).toBe(0);
        expect(existsSync(join(canonical, 'receipt.json'))).toBe(true);
        // Mixed alias/canonical spellings must not bypass output containment.
        const inside = join(canonical, 'project', 'receipt.json');
        const rejected = invoke(inside);
        expect(rejected.status).toBe(1);
        expect(String(rejected.stderr)).toContain('outside acquired inputs');
        expect(existsSync(inside)).toBe(false);
        args.roots['authored-control'] = project;
        writeFileSync(roots, JSON.stringify(args.roots));
        const aliasedInside = join(alias, 'project', 'receipt.json');
        expect(String(invoke(aliasedInside).stderr)).toContain('outside acquired inputs');
        expect(existsSync(inside)).toBe(false);
      } finally {
        rmSync(canonical, { recursive: true, force: true });
      }
    },
  );

  it('CLI rejects a receipt inside the target before scanning and leaves no receipt', () => {
    const args = input();
    const catalog = join(scratch, 'catalog.json'),
      roots = join(scratch, 'roots.json'),
      tool = join(scratch, 'tool.json');
    for (const [path, value] of [
      [catalog, args.catalog],
      [roots, args.roots],
      [tool, args.toolIdentity],
    ] as const)
      writeFileSync(path, JSON.stringify(value));
    const result = spawnSync(
      process.execPath,
      [
        join(toolRoot, 'scripts/evaluate-corpus.mjs'),
        '--manifest',
        catalog,
        '--roots',
        roots,
        '--tool-root',
        toolRoot,
        '--tool-identity',
        tool,
        '--output',
        join(project, 'receipt.json'),
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('outside acquired inputs');
    expect(existsSync(join(project, 'receipt.json'))).toBe(false);
    expect(readFileSync(join(project, 'package.json'), 'utf8')).toBe('{}');
  });
});
