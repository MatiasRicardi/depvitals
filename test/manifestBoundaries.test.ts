import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/cli/runCli.js';
import { analyzeProject } from '../src/core/analyzeProject.js';
import { findEslintManifestUsage } from '../src/detectors/eslintManifestConfig.js';
import { findEslintRcJsonUsage } from '../src/detectors/eslintRcJsonConfig.js';
import { findJestManifestUsage } from '../src/detectors/jestManifestConfig.js';
import { loadPackageTypeHint, loadProjectManifest } from '../src/scanner/projectManifest.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    lstat: vi.fn(actual.lstat),
  };
});

const ENTRY = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const readers = [findEslintManifestUsage, findEslintRcJsonUsage, findJestManifestUsage];
const inventory = JSON.stringify({
  dependencies: { 'outside-only': '*' },
  devDependencies: { 'eslint-config-prettier': '*', 'ts-jest': '*' },
  eslintConfig: { extends: 'prettier' },
  jest: { preset: 'ts-jest' },
});

async function withProject(work: (root: string, outside: string) => Promise<void>): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-boundary-'));
  const root = join(sandbox, 'project');
  const outside = join(sandbox, 'outside.json');
  mkdirSync(root);
  writeFileSync(outside, inventory);
  writeFileSync(join(root, 'package.json'), '{}');
  try {
    await work(root, outside);
    expect(readFileSync(outside, 'utf8')).toBe(inventory);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function makeEntry(path: string, outside: string, kind: string): Promise<void> {
  if (kind === 'directory') mkdirSync(path);
  else {
    if (kind === 'invalid-link') writeFileSync(`${outside}.invalid`, '{not json');
    if (kind === 'directory-link') mkdirSync(`${outside}.dir`);
    const destination =
      kind === 'dangling-link'
        ? `${outside}.absent`
        : kind === 'invalid-link'
          ? `${outside}.invalid`
          : kind === 'directory-link'
            ? `${outside}.dir`
            : outside;
    await fs.symlink(destination, path, kind === 'directory-link' ? 'junction' : 'file');
  }
}

function assertCliFailure(root: string, path: string): void {
  const result = spawnSync(process.execPath, [ENTRY, root], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(path);
  expect(result.stderr).not.toContain('not valid JSON');
  expect(result.stderr).not.toContain('outside-only');
}

for (const scope of ['root', 'nested'] as const) {
  describe(`${scope} mandatory manifest filesystem boundaries`, () => {
    for (const kind of [
      'valid-link',
      'invalid-link',
      'dangling-link',
      'directory-link',
      'directory',
    ]) {
      it(`rejects ${kind} before content reads`, async (context) => {
        await withProject(async (root, outside) => {
          const directory = scope === 'root' ? root : join(root, 'child');
          mkdirSync(directory, { recursive: true });
          const path = join(directory, 'package.json');
          if (scope === 'root') rmSync(path);
          try {
            await makeEntry(path, outside, kind);
          } catch (error) {
            if (
              process.platform === 'win32' &&
              error instanceof Error &&
              'code' in error &&
              ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))
            ) {
              context.skip(`Symlink creation unavailable: ${String(error.code)}`);
            }
            throw error;
          }
          writeFileSync(join(directory, 'index.js'), "import 'real-source';");
          const start = vi.mocked(fs.readFile).mock.calls.length;
          const load = scope === 'root' ? loadProjectManifest : loadPackageTypeHint;
          await expect(load(directory)).rejects.toMatchObject({
            name: 'ProjectManifestError',
            code: 'unreadable',
          });
          await expect(analyzeProject(root)).rejects.toMatchObject({
            name: 'ProjectManifestError',
            code: 'unreadable',
          });
          const result = await runCli([root], { cwd: root, version: '0.2.0' });
          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe('');
          expect(result.stderr).toContain(path);
          if (scope === 'root') {
            for (const reader of readers) expect([...(await reader(root))]).toEqual([]);
          }
          expect(
            vi
              .mocked(fs.readFile)
              .mock.calls.slice(start)
              .map(([file]) => file),
          ).not.toContain(path);
          assertCliFailure(root, path);
        });
      });
    }
  });
}

it('rejects a linked selected root before detector or manifest reads', async (context) => {
  await withProject(async (root, outside) => {
    const linkedRoot = `${root}-link`;
    try {
      await fs.symlink(root, linkedRoot, 'junction');
    } catch (error) {
      if (
        process.platform === 'win32' &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        context.skip('Symlink creation unavailable');
      }
      throw error;
    }
    writeFileSync(join(root, 'package.json'), inventory);
    writeFileSync(join(root, '.eslintrc.json'), '{invalid optional JSON');
    const reads = vi.mocked(fs.readFile).mock.calls.length;
    const listings = vi.mocked(fs.readdir).mock.calls.length;
    await expect(analyzeProject(linkedRoot)).rejects.toMatchObject({
      name: 'SourceFilesError',
      code: 'not-a-directory',
    });
    for (const reader of readers) expect([...(await reader(linkedRoot))]).toEqual([]);
    expect(await runCli([linkedRoot], { cwd: root, version: '0.2.0' })).toMatchObject({
      exitCode: 1,
      stdout: '',
    });
    expect(vi.mocked(fs.readFile).mock.calls.slice(reads)).toEqual([]);
    expect(vi.mocked(fs.readdir).mock.calls.slice(listings)).toEqual([]);
    assertCliFailure(linkedRoot, linkedRoot);
    expect(readFileSync(outside, 'utf8')).toBe(inventory);
  });
});

it.each([loadProjectManifest, loadPackageTypeHint])(
  'preserves a read failure and its cause (%s)',
  async (load) => {
    await withProject(async (root) => {
      const denied = Object.assign(new Error('Access denied'), { code: 'EACCES' });
      vi.mocked(fs.readFile).mockRejectedValueOnce(denied);
      await expect(load(root)).rejects.toMatchObject({
        name: 'ProjectManifestError',
        code: 'unreadable',
        cause: denied,
      });
    });
  },
);

it('does not inherit a scope if a present manifest disappears before reading', async () => {
  await withProject(async (root) => {
    const disappeared = Object.assign(new Error('Disappeared'), { code: 'ENOENT' });
    vi.mocked(fs.readFile).mockRejectedValueOnce(disappeared);
    await expect(loadPackageTypeHint(root)).rejects.toMatchObject({
      name: 'ProjectManifestError',
      code: 'unreadable',
      cause: disappeared,
    });
  });
});

it('only inherits an absent nested manifest; regular metadata keeps its scope', async () => {
  await withProject(async (root) => {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const child = join(root, 'child');
    mkdirSync(child);
    writeFileSync(join(child, 'index.js'), "import 'real-source';");
    expect(await loadPackageTypeHint(child)).toBeUndefined();
    expect((await analyzeProject(root)).missingDependencies).toEqual(['real-source']);
    writeFileSync(join(child, 'package.json'), '{}');
    expect(await loadPackageTypeHint(child)).toEqual({ packageType: undefined });
    writeFileSync(join(child, 'package.json'), '{"type":"commonjs"}');
    expect(await loadPackageTypeHint(child)).toEqual({ packageType: 'commonjs' });
    writeFileSync(join(child, 'package.json'), '{bad');
    await expect(analyzeProject(root)).rejects.toMatchObject({
      name: 'ProjectManifestError',
      code: 'invalid-json',
    });
  });
});

it('validates mandatory metadata before optional configuration errors', async () => {
  await withProject(async (root) => {
    const path = join(root, 'package.json');
    writeFileSync(path, '{bad mandatory json');
    writeFileSync(join(root, '.eslintrc.json'), '{bad optional json');
    expect(await runCli([root], { cwd: root, version: '0.2.0' })).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `${path} is not valid JSON\n`,
    });
  });
});

it('keeps optional linked configuration as a presence barrier without reading it', async (context) => {
  await withProject(async (root, outside) => {
    const path = join(root, '.eslintrc.json');
    try {
      await fs.symlink(outside, path, 'file');
    } catch (error) {
      if (
        process.platform === 'win32' &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        context.skip('Symlink creation unavailable');
      }
      throw error;
    }
    writeFileSync(join(root, 'package.json'), inventory);
    expect([...(await findEslintManifestUsage(root))]).toEqual([]);
    expect([...(await findEslintRcJsonUsage(root))]).toEqual([]);
    const result = await runCli([root], { cwd: root, version: '0.2.0' });
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('eslint-config-prettier');
    expect(result.stdout).not.toContain('  ts-jest');
  });
});

it('does not treat an inaccessible nested entry as an absent scope', async () => {
  await withProject(async (root) => {
    const denied = Object.assign(new Error('Metadata access denied'), { code: 'EACCES' });
    vi.mocked(fs.lstat).mockRejectedValueOnce(denied);
    await expect(loadPackageTypeHint(root)).rejects.toMatchObject({
      name: 'ProjectManifestError',
      code: 'unreadable',
      cause: denied,
    });
  });
});
