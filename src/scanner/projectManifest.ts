/**
 * Project manifest discovery.
 *
 * This module answers exactly one question: "what does this package declare?". It loads the root
 * `package.json` of a single Node.js project and turns it into a deterministic dependency
 * inventory.
 *
 * It deliberately does not:
 * - decide whether a dependency is used, unused or missing (that belongs to the analyzers);
 * - walk upward looking for a parent manifest or interpret workspaces (`v0.1.0` is
 *   single-package);
 * - execute or import anything from the analyzed project;
 * - mutate the analyzed project.
 *
 * The manifest is read as text and parsed with `JSON.parse`, so no target-project code runs. The
 * text is read as UTF-8 without any BOM handling: a manifest that `JSON.parse` rejects is reported
 * as invalid instead of being silently normalized.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * A dependency section: package name mapped to the version specifier declared for it.
 *
 * Version specifiers are kept verbatim; DepVitals never validates semver ranges here.
 */
export type DependencyMap = Readonly<Record<string, string>>;

/**
 * The declared contents of one project manifest.
 *
 * `declaredDependencyNames` is the union of every dependency section and exists only to suppress
 * obviously wrong "missing" results later. Unused analysis is restricted to `dependencies` and
 * `devDependencies`; peer and optional dependencies are never reported as unused in `v0.1.0`.
 */
export type ProjectManifest = {
  /** Absolute, normalized project root as supplied to {@link loadProjectManifest}. */
  root: string;
  /** Path of the `package.json` that was loaded from `root`. */
  packageJsonPath: string;
  /** Package name. Omitted when the manifest declares none. */
  name?: string;
  dependencies: DependencyMap;
  devDependencies: DependencyMap;
  declaredDependencyNames: ReadonlySet<string>;
  /** `scripts` entries as static strings, never executed. */
  scripts: Readonly<Record<string, string>>;
};

/**
 * Why a manifest could not be turned into a {@link ProjectManifest}.
 *
 * - `missing`: no `package.json` exists at the expected path.
 * - `unreadable`: the file exists but could not be read (permissions, not a directory, ...).
 * - `invalid-json`: the file content is not valid JSON.
 * - `invalid-shape`: the JSON is valid but its structure is not what the model requires.
 */
export type ProjectManifestErrorCode = 'missing' | 'unreadable' | 'invalid-json' | 'invalid-shape';

const MANIFEST_FILENAME = 'package.json';

/**
 * Operational error for manifest loading. The `code` lets callers (the CLI in a later step) render
 * a clean message without matching on error strings.
 */
export class ProjectManifestError extends Error {
  readonly code: ProjectManifestErrorCode;

  constructor(message: string, code: ProjectManifestErrorCode, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProjectManifestError';
    this.code = code;
  }
}

/**
 * Load the root `package.json` of the project rooted at `projectRoot`.
 *
 * The supplied root is resolved to an absolute path; `process.cwd()` is never changed and the
 * target project is never written to.
 *
 * @throws {ProjectManifestError} when the manifest is missing, unreadable, invalid JSON, or has an
 * unexpected structure.
 */
export async function loadProjectManifest(projectRoot: string): Promise<ProjectManifest> {
  const root = resolve(projectRoot);
  const packageJsonPath = join(root, MANIFEST_FILENAME);

  let text: string;
  try {
    text = await readFile(packageJsonPath, 'utf8');
  } catch (error) {
    throw toReadError(packageJsonPath, error);
  }

  return parseManifest(root, packageJsonPath, text);
}

/**
 * Classify a filesystem failure: a missing manifest is expected and reported separately from any
 * other I/O problem. A root that turns out to be a file surfaces as `ENOTDIR` and stays unreadable.
 */
function toReadError(packageJsonPath: string, error: unknown): ProjectManifestError {
  if (isNotFoundError(error)) {
    return new ProjectManifestError(
      `No ${MANIFEST_FILENAME} found at ${packageJsonPath}`,
      'missing',
      error,
    );
  }

  return new ProjectManifestError(
    `Could not read ${MANIFEST_FILENAME} at ${packageJsonPath}`,
    'unreadable',
    error,
  );
}

/**
 * Whether an unknown thrown value is the filesystem `ENOENT` error.
 */
function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Parse manifest text into the internal model.
 */
function parseManifest(root: string, packageJsonPath: string, text: string): ProjectManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProjectManifestError(`${packageJsonPath} is not valid JSON`, 'invalid-json', error);
  }

  if (!isPlainRecord(parsed)) {
    throw new ProjectManifestError(
      `${packageJsonPath} must contain a JSON object`,
      'invalid-shape',
    );
  }

  const dependencies = readStringRecord(parsed, 'dependencies', packageJsonPath);
  const devDependencies = readStringRecord(parsed, 'devDependencies', packageJsonPath);
  const optionalDependencies = readStringRecord(parsed, 'optionalDependencies', packageJsonPath);
  const peerDependencies = readStringRecord(parsed, 'peerDependencies', packageJsonPath);
  const scripts = readStringRecord(parsed, 'scripts', packageJsonPath);
  const name = readName(parsed, packageJsonPath);

  const manifest: ProjectManifest = {
    root,
    packageJsonPath,
    dependencies,
    devDependencies,
    declaredDependencyNames: declaredNames([
      dependencies,
      devDependencies,
      optionalDependencies,
      peerDependencies,
    ]),
    scripts,
  };

  return name === undefined ? manifest : { ...manifest, name };
}

/**
 * Read the optional `name` field. Its type is validated, but npm package-name rules are not.
 */
function readName(manifest: Record<string, unknown>, packageJsonPath: string): string | undefined {
  const value: unknown = manifest['name'];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new ProjectManifestError(
      `${packageJsonPath} field "name" must be a string when present`,
      'invalid-shape',
    );
  }

  return value;
}

/**
 * Read one manifest section as a string map.
 *
 * A missing section is empty. A present section must be an object whose values are all strings;
 * anything else is an explicit error rather than a silent guess. Keys are package names or script
 * names and are kept verbatim (no package-name validation at this stage).
 */
function readStringRecord(
  manifest: Record<string, unknown>,
  section: string,
  packageJsonPath: string,
): Readonly<Record<string, string>> {
  const value: unknown = manifest[section];

  if (value === undefined) {
    return {};
  }

  if (!isPlainRecord(value)) {
    throw new ProjectManifestError(
      `${packageJsonPath} field "${section}" must be an object of string values`,
      'invalid-shape',
    );
  }

  const entries: [string, string][] = [];

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new ProjectManifestError(
        `${packageJsonPath} field "${section}" must map every name to a string, but "${key}" is not a string`,
        'invalid-shape',
      );
    }

    entries.push([key, entry]);
  }

  entries.sort(([a], [b]) => compareNames(a, b));

  // Rebuilt from sorted entries so later scanner steps never depend on JSON property order.
  return Object.fromEntries(entries);
}

/**
 * Deterministic union of the dependency names of every supplied section.
 */
function declaredNames(sections: readonly DependencyMap[]): ReadonlySet<string> {
  const names = new Set<string>();

  for (const section of sections) {
    for (const name of Object.keys(section)) {
      names.add(name);
    }
  }

  // Rebuilt from sorted names so iteration is deterministic even when sections overlap.
  return new Set<string>([...names].sort(compareNames));
}

/**
 * A JSON object (not an array, not `null`) whose keys are strings.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Locale-independent lexicographic ordering, so the same manifest always yields the same order.
 */
function compareNames(a: string, b: string): number {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
}
