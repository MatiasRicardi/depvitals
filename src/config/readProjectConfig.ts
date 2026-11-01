/**
 * Internal, root-only JSON configuration readers. The CLI loads readProjectConfig on scans only;
 * only that reader returns semantically validated rules.
 */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { assertReadableRoot } from '../scanner/sourceFiles.js';
import { normalizeIgnoreDependencies } from './ignoreDependencies.js';
import { normalizeIgnorePaths } from './ignorePaths.js';
import { ProjectConfigError } from './projectConfigError.js';

export type RawProjectConfig = {
  readonly ignorePaths: readonly string[];
  readonly ignoreDependencies: readonly string[];
};

export { ProjectConfigError, type ProjectConfigErrorCode } from './projectConfigError.js';

const CONFIG_FILENAME = 'depvitals.config.json';

/**
 * Read exactly the canonical config entry in the selected root. No parents, alternatives or rule
 * destinations are consulted. Only absence is defaults. Present non-regular/unreadable entries and
 * malformed documents fail as a whole. Existing root errors use the shared SourceFilesError guard.
 *
 * Strings retain their original spelling, order and duplicates for later semantic validators.
 * A single leading UTF-8 BOM is accepted; all remaining syntax is native strict JSON.parse.
 * Stable entry checks do not claim adversarial protection against replacement between I/O calls.
 */
export async function readRawProjectConfig(projectRoot: string): Promise<RawProjectConfig> {
  const root = resolve(projectRoot);
  const path = join(root, CONFIG_FILENAME);
  await assertReadableRoot(root);

  let entries: string[];
  try {
    // Exact entry-name comparison also enforces canonical casing on case-insensitive hosts.
    entries = await readdir(root);
  } catch (error) {
    throw unreadable(path, error);
  }
  if (!entries.includes(CONFIG_FILENAME)) return emptyConfig();

  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    // The directory entry was already present, so disappearance is an error, not absence.
    throw unreadable(path, error);
  }
  if (!info.isFile()) {
    throw new ProjectConfigError(
      `${path} must be a regular file; symlinks and non-regular entries are not read`,
      'unreadable',
    );
  }

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw unreadable(path, error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new ProjectConfigError(`${path} is not valid JSON`, 'invalid-json', error);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProjectConfigError(`${path} must contain a JSON object`, 'invalid-shape');
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'ignorePaths' && key !== 'ignoreDependencies') {
      throw new ProjectConfigError(
        `${path} has unsupported field ${JSON.stringify(key)}; only ignorePaths and ignoreDependencies are supported`,
        'invalid-shape',
      );
    }
  }
  const config = parsed as Record<string, unknown>;
  return Object.freeze({
    ignorePaths: readStrings(config['ignorePaths'], 'ignorePaths', path),
    ignoreDependencies: readStrings(config['ignoreDependencies'], 'ignoreDependencies', path),
  });
}

function readStrings(
  value: unknown,
  field: keyof RawProjectConfig,
  path: string,
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new ProjectConfigError(
      `${path} field ${field} must be an array of strings`,
      'invalid-shape',
    );
  }
  const strings: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index];
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new ProjectConfigError(
        `${path} field ${field}[${String(index)}] must be a nonempty, non-whitespace string`,
        'invalid-shape',
      );
    }
    strings.push(entry);
  }
  return Object.freeze(strings);
}

function emptyConfig(): RawProjectConfig {
  return Object.freeze({ ignorePaths: Object.freeze([]), ignoreDependencies: Object.freeze([]) });
}

function unreadable(path: string, cause: unknown): ProjectConfigError {
  return new ProjectConfigError(
    `Could not read ${CONFIG_FILENAME} at ${path}`,
    'unreadable',
    cause,
  );
}

/** Validated internal snapshot; no policy is applied to discovery or findings here. */
export type ProjectConfig = {
  readonly ignorePaths: readonly string[];
  readonly ignoreDependencies: readonly string[];
};

/** Read once, validate all path/name rules, and return no partial configuration on failure. */
export async function readProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const raw = await readRawProjectConfig(projectRoot);
  const path = join(resolve(projectRoot), CONFIG_FILENAME);
  return Object.freeze({
    ignorePaths: normalizeIgnorePaths(raw.ignorePaths, path),
    ignoreDependencies: normalizeIgnoreDependencies(raw.ignoreDependencies, path),
  });
}
