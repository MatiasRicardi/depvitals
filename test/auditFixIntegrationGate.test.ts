import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runCli, type CliResult } from '../src/cli/runCli.js';
import { analyzeProject, type AnalysisResult } from '../src/core/analyzeProject.js';
import { findEslintManifestUsage } from '../src/detectors/eslintManifestConfig.js';
import { findEslintRcJsonUsage } from '../src/detectors/eslintRcJsonConfig.js';
import { findJestManifestUsage } from '../src/detectors/jestManifestConfig.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/analysis/audit-fix-baseline/', import.meta.url));
const ENTRY = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
type Variant = 'declared' | 'undeclared' | 'external-eslint';
type Baseline = {
  configUsedNames: readonly string[];
  rawAnalysis: Omit<AnalysisResult, 'projectRoot'>;
  analysis: Omit<AnalysisResult, 'projectRoot'>;
  cli: CliResult;
};
// Hand-authored expectations; no production reporter or scan generates these golden values.
const EXPECTED = JSON.parse(
  readFileSync(
    new URL('./fixtures/analysis/audit-fix-baseline.expected.json', import.meta.url),
    'utf8',
  ),
) as Record<Variant, Baseline>;

function snapshot(root: string): readonly { path: string; bytes: string }[] {
  const files: { path: string; bytes: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        files.push({
          path: relative(root, path).split('\\').join('/'),
          bytes: readFileSync(path).toString('hex'),
        });
    }
  };
  walk(root);
  return files.toSorted((a, b) => a.path.localeCompare(b.path));
}

async function withProject(work: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'depvitals-audit-baseline-'));
  try {
    cpSync(FIXTURE, root, { recursive: true });
    await work(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function compiled(root: string): CliResult {
  const result = spawnSync(process.execPath, [ENTRY, root], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).not.toBeNull();
  return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

async function hints(root: string): Promise<ReadonlySet<string>> {
  return new Set([
    ...(await findEslintManifestUsage(root)),
    ...(await findEslintRcJsonUsage(root)),
    ...(await findJestManifestUsage(root)),
  ]);
}

describe('Step 86 corrected default audit integration baseline', () => {
  it.each<Variant>(['declared', 'undeclared', 'external-eslint'])(
    'composes every evidence source: %s',
    async (variant) => {
      await withProject(async (root) => {
        if (variant === 'undeclared') {
          const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<
            string,
            unknown
          >;
          delete manifest['dependencies'];
          delete manifest['devDependencies'];
          writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
        } else if (variant === 'external-eslint') {
          writeFileSync(join(root, '.eslintrc.json'), '{"plugins":["react"]}\n');
        }
        const before = snapshot(root);
        const expected = EXPECTED[variant];
        const configUsedNames = await hints(root);
        expect([...configUsedNames]).toEqual(expected.configUsedNames);
        expect(await analyzeProject(root)).toEqual({ projectRoot: root, ...expected.rawAnalysis });
        const result = await analyzeProject(root, { configUsedNames });
        expect(result).toEqual({ projectRoot: root, ...expected.analysis });
        const options = { cwd: root, version: '0.2.0' };
        expect(await runCli([], options)).toEqual(expected.cli);
        expect(await runCli([root], options)).toEqual(expected.cli);
        expect(compiled(root)).toEqual(expected.cli);
        // Same scan repeated: deterministic ordering, deduplication and no ambient cache influence.
        expect(await analyzeProject(root, { configUsedNames })).toEqual(result);
        if (variant === 'declared') {
          for (const file of ['index.js', 'script-control.cjs', 'child/index.cjs']) {
            const syntax = spawnSync(process.execPath, ['--check', join(root, file)], {
              encoding: 'utf8',
              timeout: 10_000,
            });
            expect(syntax.error).toBeUndefined();
            expect(syntax.status, syntax.stderr).toBe(0);
          }
        }
        expect(snapshot(root)).toEqual(before);
        expect(readdirSync(root)).not.toContain('SCRIPT_RAN');
      });
    },
  );

  for (const location of ['root', 'nested'] as const) {
    for (const kind of ['invalid-json', 'directory'] as const) {
      it(`mandatory ${location} manifest ${kind} preempts an otherwise useful report`, async () => {
        await withProject(async (root) => {
          const path = join(root, location === 'root' ? 'package.json' : 'child/package.json');
          if (kind === 'directory') {
            rmSync(path);
            mkdirSync(path);
          } else writeFileSync(path, '{invalid mandatory JSON');
          const before = snapshot(root);
          await expect(analyzeProject(root)).rejects.toMatchObject({
            name: 'ProjectManifestError',
            code: kind === 'directory' ? 'unreadable' : 'invalid-json',
          });
          const expected: CliResult = {
            exitCode: 1,
            stdout: '',
            stderr:
              kind === 'directory'
                ? `${path} must be a regular file; symlinks and non-regular entries are not read\n`
                : `${path} is not valid JSON\n`,
          };
          expect(await runCli([root], { cwd: root, version: '0.2.0' })).toEqual(expected);
          expect(compiled(root)).toEqual(expected);
          expect(snapshot(root)).toEqual(before);
        });
      });
    }
  }

  it('a lexical source failure never becomes a partial report', async () => {
    await withProject(async (root) => {
      const path = join(root, 'broken.js');
      writeFileSync(path, "import 'unterminated");
      const before = snapshot(root);
      await expect(analyzeProject(root)).rejects.toMatchObject({
        name: 'AnalysisError',
        code: 'invalid-source',
      });
      const direct = await runCli([root], { cwd: root, version: '0.2.0' });
      expect(direct.exitCode).toBe(1);
      expect(direct.stdout).toBe('');
      expect(direct.stderr).toContain(path);
      expect(compiled(root)).toEqual(direct);
      expect(snapshot(root)).toEqual(before);
    });
  });
});
