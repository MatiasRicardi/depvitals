/**
 * Source file discovery.
 *
 * This module answers exactly one question: "which source files should DepVitals inspect?". It
 * walks a single Node.js project tree and returns the supported JavaScript/TypeScript files without
 * parsing them.
 *
 * It deliberately does not:
 * - read, parse or execute any discovered file (that belongs to the analyzers / specifier extractor);
 * - decide whether anything is used, unused or missing;
 * - parse `.gitignore` or honor custom ignore configuration (`v0.1.0` uses a fixed built-in set);
 * - follow symlinks, which avoids cycles and scanning content outside the intended project tree;
 * - mutate the analyzed project.
 *
 * Traversal uses `fs.readdir` with `withFileTypes` so ignored directories are pruned before descent
 * instead of walking every subtree and filtering afterwards. The result is sorted deterministically
 * so the same tree always yields the same order.
 */

import { lstat, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

/**
 * The supported source and declaration extensions for `v0.1.0`.
 *
 * Multi-part declaration files are included through their base extension:
 * - `foo.d.ts`    resolves to `.ts`
 * - `foo.d.mts`   resolves to `.mts`
 * - `foo.d.cts`   resolves to `.cts`
 *
 * The rule that matters is only "never exclude a name because it starts with `.d`".
 */
const SUPPORTED_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]);

/**
 * Directories pruned by name wherever they appear. These are generated, vendor or tooling trees
 * that must never be enumerated (in particular `node_modules`).
 */
const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  '.cache',
  '.turbo',
  '.next',
  '.nuxt',
]);

/**
 * A discovered source file as an absolute, platform-separated path, sorted lexicographically.
 */
export type DiscoveredSourceFile = string;

/**
 * Why source discovery could not run.
 *
 * - `missing`: the project root does not exist.
 * - `not-a-directory`: the project root exists but is a regular file.
 * - `unreadable`: the root exists, or a nested directory, could not be read (permissions, I/O
 *   error, ...).
 */
export type SourceFilesErrorCode = 'missing' | 'not-a-directory' | 'unreadable';

/**
 * Operational error for source discovery. The `code` lets callers (the CLI in a later step) render
 * a clean message without matching on error strings.
 */
export class SourceFilesError extends Error {
  readonly code: SourceFilesErrorCode;

  constructor(message: string, code: SourceFilesErrorCode, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SourceFilesError';
    this.code = code;
  }
}

/**
 * Discover the supported JavaScript/TypeScript source files of the project rooted at `projectRoot`.
 *
 * The supplied root is resolved to an absolute path; `process.cwd()` is never changed and the
 * target project is never read as code or written to.
 *
 * The returned paths are absolute and sorted lexicographically so the same tree always yields the
 * same order.
 *
 * @throws {SourceFilesError} when the root is missing, is not a directory, or cannot be read.
 */
export async function discoverSourceFiles(
  projectRoot: string,
): Promise<readonly DiscoveredSourceFile[]> {
  const root = resolve(projectRoot);
  await assertReadableRoot(root);

  const files: string[] = [];
  await walk(root, files);

  // Sort the final result so the contract is explicitly deterministic regardless of filesystem
  // enumeration order.
  files.sort(comparePaths);

  return files;
}

/**
 * Validate that the resolved root exists and is a directory before walking it. A missing root is
 * reported separately from a root that is a regular file, and any other I/O failure stays
 * `unreadable`.
 *
 * `lstat` (not `stat`) is used on purpose: it does not follow a symlink supplied as the root, so a
 * symlinked root is rejected instead of being traversed, keeping the "never follow symlinks"
 * contract consistent from the entry point down.
 */
async function assertReadableRoot(root: string): Promise<void> {
  try {
    const info = await lstat(root);

    if (info.isSymbolicLink()) {
      throw new SourceFilesError(
        `Project root ${root} is a symlink and will not be followed`,
        'not-a-directory',
      );
    }

    if (!info.isDirectory()) {
      throw new SourceFilesError(
        `Project root ${root} exists but is not a directory`,
        'not-a-directory',
      );
    }
  } catch (error) {
    if (error instanceof SourceFilesError) {
      throw error;
    }

    throw toReadError(root, error);
  }
}

/**
 * Recursively collect supported files under `directory`, pruning ignored directories and skipping
 * symlinks before descending.
 */
async function walk(directory: string, files: string[]): Promise<void> {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new SourceFilesError(
      `Could not read directory ${directory}: ${messageOf(error)}`,
      'unreadable',
      error,
    );
  }

  for (const entry of entries) {
    // Never follow symlinks: this avoids cycles, duplicates and escaping the project tree.
    if (entry.isSymbolicLink()) {
      continue;
    }

    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        // Prune before descending so trees like `node_modules` are never enumerated.
        continue;
      }

      await walk(fullPath, files);
      continue;
    }

    if (entry.isFile() && isSupportedFile(entry.name)) {
      files.push(fullPath);
    }
  }
}

/**
 * Whether a file name has a supported source extension.
 */
function isSupportedFile(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(fileName));
}

/**
 * Classify a filesystem failure while validating the root: a missing root is expected and reported
 * separately from any other I/O problem.
 */
function toReadError(root: string, error: unknown): SourceFilesError {
  if (isNotFoundError(error)) {
    return new SourceFilesError(`Project root ${root} does not exist`, 'missing', error);
  }

  return new SourceFilesError(
    `Could not read project root ${root}: ${messageOf(error)}`,
    'unreadable',
    error,
  );
}

/**
 * A short, human-readable reason extracted from an unknown thrown value, for error messages only.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Whether an unknown thrown value is the filesystem `ENOENT` error.
 */
function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Locale-independent lexicographic ordering, so the same tree always yields the same order.
 */
function comparePaths(a: string, b: string): number {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
}
