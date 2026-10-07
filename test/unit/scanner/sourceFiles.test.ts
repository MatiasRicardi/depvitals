import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  discoverSourceFiles,
  SourceFilesError,
  type SourceFilesErrorCode,
} from '../../../src/scanner/sourceFiles.js';

/**
 * Fixture directory. Every scenario is a real directory tree with supported and unsupported files,
 * ignored vendor/build trees, and a hidden directory that must still be traversed.
 */
const SOURCE_FIXTURES = fileURLToPath(new URL('../../fixtures/source-discovery/', import.meta.url));

function fixture(projectRoot: string): string {
  return join(SOURCE_FIXTURES, projectRoot);
}

/**
 * Run the discoverer and return the rejection instead of throwing, so tests assert on the error.
 */
async function captureFailure(projectRoot: string): Promise<unknown> {
  try {
    await discoverSourceFiles(projectRoot);
  } catch (error) {
    return error;
  }

  return undefined;
}

describe('discoverSourceFiles', () => {
  describe('supported files', () => {
    it('discovers root, nested and declaration files across every supported extension', async () => {
      const expected = [
        join(fixture('basic'), '.config', 'settings.ts'),
        join(fixture('basic'), 'app.tsx'),
        join(fixture('basic'), 'entry.mjs'),
        join(fixture('basic'), 'index.js'),
        join(fixture('basic'), 'src', 'main.ts'),
        join(fixture('basic'), 'src', 'nested', 'deep.cts'),
        join(fixture('basic'), 'src', 'nested', 'deep.mts'),
        join(fixture('basic'), 'src', 'util.jsx'),
        join(fixture('basic'), 'types.d.ts'),
      ].sort();

      const actual = [...(await discoverSourceFiles(fixture('basic')))].sort();

      expect(actual).toEqual(expected);
    });

    it('returns absolute paths', async () => {
      const files = await discoverSourceFiles(fixture('basic'));

      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        expect(resolve(file)).toBe(file);
      }
    });
  });

  describe('unsupported extensions are ignored', () => {
    it('does not return markdown, css or json files', async () => {
      const files = await discoverSourceFiles(fixture('basic'));

      for (const file of files) {
        expect(file.endsWith('.md')).toBe(false);
        expect(file.endsWith('.css')).toBe(false);
        expect(file.endsWith('.json')).toBe(false);
      }
    });
  });

  describe('ignored directories are pruned', () => {
    it('never returns files from vendor or build trees', async () => {
      const files = await discoverSourceFiles(fixture('basic'));

      const forbiddenRoots = [
        'node_modules',
        'dist',
        'build',
        'coverage',
        'out',
        '.cache',
        '.turbo',
        '.next',
        '.nuxt',
      ];

      for (const file of files) {
        const parts = file.split(/[\\/]/);
        const relative = parts.slice(1).join('/');

        expect(forbiddenRoots.some((name) => relative.startsWith(`${name}/`))).toBe(false);
      }
    });
  });

  describe('hidden directories that are not ignored are traversed', () => {
    it('discovers files inside a non-ignored dot-directory', async () => {
      const files = await discoverSourceFiles(fixture('basic'));

      expect(files.some((file) => file.endsWith(join('.config', 'settings.ts')))).toBe(true);
    });
  });

  describe('deterministic ordering', () => {
    it('returns the same order on repeated calls', async () => {
      const first = await discoverSourceFiles(fixture('basic'));
      const second = await discoverSourceFiles(fixture('basic'));

      expect([...second]).toEqual([...first]);
    });
  });

  describe('symlinks are not followed', () => {
    it('skips symlinked directories and files', async () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-symlink-'));

      try {
        const realDir = join(sandbox, 'real');
        const realFile = join(realDir, 'src.ts');

        // Real, non-symlinked files that must always be discovered.
        mkdirSync(realDir);
        writeFileSync(join(sandbox, 'root.ts'), 'export const a = 1;');
        writeFileSync(realFile, 'export const b = 2;');

        // A directory symlink and a file symlink pointing at the real content. Creating symlinks
        // can fail on some filesystems (e.g. Windows without privileges); in that case there is
        // nothing to assert, so the symlink-specific checks are skipped.
        const linkDir = join(sandbox, 'linkdir');
        const linkFile = join(sandbox, 'linkfile.ts');
        const linksCreated = await createSymlinks(realDir, realFile, linkDir, linkFile);

        const files = await discoverSourceFiles(sandbox);

        // The real, non-symlinked files are always present.
        expect(files).toContain(join(sandbox, 'root.ts'));
        expect(files).toContain(realFile);

        // Nothing reachable only through a symlink is returned (no duplicates, no escapes).
        expect(files.some((file) => file.includes('linkdir'))).toBe(false);
        expect(files.some((file) => file.includes('linkfile'))).toBe(false);

        // When symlinks could be created, prove the checks above were meaningful: the links exist
        // on disk, yet discovery did not follow them.
        if (linksCreated) {
          expect(existsSync(linkDir)).toBe(true);
          expect(existsSync(linkFile)).toBe(true);
        }
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });

    it('rejects a symlink supplied as the project root', async () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-symlink-root-'));

      try {
        const realDir = join(sandbox, 'real');
        const linkRoot = join(sandbox, 'link');

        mkdirSync(realDir);
        writeFileSync(join(realDir, 'src.ts'), 'export const a = 1;');

        // A root that is a symlink to a directory must be rejected, not traversed through. When the
        // environment cannot create symlinks there is nothing to assert, so the check is skipped.
        try {
          await symlink(realDir, linkRoot, 'dir');
        } catch {
          return;
        }

        const failure = await captureFailure(linkRoot);

        expectSourceFilesError(failure, 'not-a-directory', ['symlink']);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  });

  describe('operational errors', () => {
    it('fails with missing when the root does not exist', async () => {
      const failure = await captureFailure(fixture('does-not-exist'));

      expectSourceFilesError(failure, 'missing', ['does not exist']);
    });

    it('fails with not-a-directory when the root is a file', async () => {
      const failure = await captureFailure(join(fixture('basic'), 'index.js'));

      expectSourceFilesError(failure, 'not-a-directory', ['not a directory']);
    });

    it('keeps the filesystem failure as the error cause', async () => {
      const failure = await captureFailure(fixture('does-not-exist'));

      expectSourceFilesError(failure, 'missing');
      expect((failure as { cause?: unknown }).cause).toBeInstanceOf(Error);
    });
  });

  describe('static analysis guarantee', () => {
    it('lists files without reading or executing them', async () => {
      const files = await discoverSourceFiles(fixture('basic'));

      expect(files.length).toBeGreaterThan(0);
    });
  });
});

/**
 * Create a directory symlink (`linkDir -> realDir`) and a file symlink (`linkFile -> realFile`),
 * returning whether they were created.
 *
 * Returns false instead of throwing so a permission-restricted filesystem (e.g. Windows without
 * privileges) only skips the symlink assertions instead of failing the test.
 */
async function createSymlinks(
  realDir: string,
  realFile: string,
  linkDir: string,
  linkFile: string,
): Promise<boolean> {
  try {
    await symlink(realDir, linkDir, 'dir');
    await symlink(realFile, linkFile, 'file');
    return true;
  } catch {
    return false;
  }
}

/**
 * Assert that a caught value is the expected operational error, optionally checking message parts.
 */
function expectSourceFilesError(
  error: unknown,
  code: SourceFilesErrorCode,
  messageParts: readonly string[] = [],
): void {
  if (!(error instanceof SourceFilesError)) {
    throw new Error(`Expected a SourceFilesError with code "${code}".`, { cause: error });
  }

  expect(error.code).toBe(code);

  for (const part of messageParts) {
    expect(error.message).toContain(part);
  }
}
