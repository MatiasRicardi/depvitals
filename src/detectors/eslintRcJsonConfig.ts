/**
 * Legacy external `.eslintrc.json` usage detection.
 *
 * This module adds exactly one static data source to the ESLint rules proven in Step 57: the single
 * file `<projectRoot>/.eslintrc.json`. Its parsed JSON document is handed to the same pure matcher
 * ({@link findEslintConfigUsage}) that reads `package.json#eslintConfig`, so the fixed allowlists,
 * the exact-string lookup and the "declared packages only" rule are reused instead of duplicated.
 * The result is a set of configuration-only package names for the Step 56 analyzer seam, so a
 * recognized name can only suppress an `unused` finding and can never create a `missing` one.
 *
 * It deliberately does not:
 * - evaluate, `import()`, `require()` or otherwise run ESLint, a config loader or any target code.
 *   The file is read as UTF-8 text and parsed with `JSON.parse`;
 * - support any other legacy format: `.eslintrc.js` / `.cjs` / `.mjs` (JavaScript config modules),
 *   `.eslintrc.yml` / `.yaml` and extensionless `.eslintrc` are explicitly dismissed in this
 *   release, as is JSON5 or comment-tolerant JSON. A `.eslintrc.json` that uses JavaScript-style
 *   comments is therefore reported as the operational error described below rather than parsed by a
 *   second JSON dialect: DepVitals reads one strict JSON document, and a hand-written comment
 *   stripper that mis-handled a `//` inside a string value could alter the document and invent
 *   evidence. A leading UTF-8 BOM is different - it is an encoding artifact of the very same
 *   document, so it is removed before parsing;
 * - traverse parent directories, nested packages or workspaces looking for further config files, or
 *   resolve `extends` references to other configuration files;
 * - read anything besides the `extends`/`plugins` subset that {@link findEslintConfigUsage} accepts;
 *   every other ESLint field (`env`, `globals`, `rules`, `parserOptions`, `overrides`, ...) is
 *   ignored, and no unknown value produces evidence;
 * - report anything about a package the manifest does not declare, or mutate the analyzed project.
 *
 * Two conservative file rules keep the reader honest:
 *
 * - only a regular file at exactly `<projectRoot>/.eslintrc.json` is read. The path is built from a
 *   fixed file name joined to the resolved root, so it cannot point outside the project, and
 *   `lstat` (not `stat`) is used so a symlinked `.eslintrc.json` is skipped rather than followed.
 *   Following a link could read content that lives outside the analyzed tree, which the scan policy
 *   forbids; skipping is the safe answer and is a documented limitation;
 * - a file that exists and is a regular file but cannot be read or parsed is reported as an
 *   operational {@link EslintRcJsonError}. Silently ignoring it would drop the only evidence for a
 *   package that the broken configuration may well reference, and would let the scan present a
 *   misleadingly clean or wrongly `unused` result. Valid JSON with an unusable top-level shape
 *   (array, string, number, `null`) is different: it is not an ESLint configuration at all, so it
 *   contributes no evidence and is never an error, exactly like the unknown-field case.
 *
 * Precedence follows the legacy ESLint rule that one active configuration wins: a hard barrier (a
 * modern flat config or `.eslintrc.js`/`.cjs`/`.yaml`/`.yml`) disables every legacy hint, and
 * otherwise this file wins over `package.json#eslintConfig`. The precedence is computed once by a
 * helper both legacy readers share; the barrier is presence-based and never reads the displaced
 * source for evidence, so two contradictory legacy sources are never unioned.
 */

import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadProjectManifest, ProjectManifestError } from '../scanner/projectManifest.js';
import { SourceFilesError } from '../scanner/sourceFiles.js';
import { findEslintConfigUsage, readLegacyEslintPrecedence } from './eslintManifestConfig.js';

/**
 * The one file name this reader looks for, relative to the resolved project root.
 *
 * There is intentionally no list of alternative legacy names: `.eslintrc.yml`, `.eslintrc.js` and
 * the extensionless `.eslintrc` are out of scope for this release, so no reader is added for them.
 */
const ESLINTRC_FILENAME = '.eslintrc.json';

/**
 * Why a present `.eslintrc.json` could not be used as a configuration data source.
 *
 * - `unreadable`: the entry is a regular file but could not be read (permissions, I/O failure, ...).
 * - `invalid-json`: the file content is not valid JSON, so the configuration it intends to declare
 *   is unknowable rather than empty.
 *
 * A missing file, a non-regular entry (directory, FIFO, socket, symlink) and valid JSON with an
 * unusable top-level shape are not errors: they simply produce no evidence.
 */
export type EslintRcJsonErrorCode = 'unreadable' | 'invalid-json';

/**
 * Operational error for an unusable `.eslintrc.json`.
 *
 * The `code` lets callers render a clean message without matching on error strings, following the
 * existing `ProjectManifestError` / `SourceFilesError` convention. Throwing is deliberate: an
 * unreadable or unparsable configuration that DepVitals silently skipped could otherwise turn into
 * an unfounded `unused` finding.
 */
export class EslintRcJsonError extends Error {
  readonly code: EslintRcJsonErrorCode;

  constructor(message: string, code: EslintRcJsonErrorCode, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'EslintRcJsonError';
    this.code = code;
  }
}

/**
 * Collect the external `.eslintrc.json` hints for the project rooted at `projectRoot`.
 *
 * The returned set is shaped for the analyzer's `configUsedNames` option (the Step 56 handoff),
 * which is the only way configuration evidence reaches the analyzer. Nothing is decided here: the
 * analyzer stays the sole owner of the unused/missing categories, and an undeclared package can
 * never appear in the result.
 *
 * @param projectRoot - Project directory to inspect; resolved to an absolute path.
 * @throws {EslintRcJsonError} when a regular `.eslintrc.json` file exists but cannot be read or
 * parsed as JSON. Absent, skipped and unusable-but-parsable files return the empty set.
 */
export async function findEslintRcJsonUsage(projectRoot: string): Promise<ReadonlySet<string>> {
  const root = resolve(projectRoot);

  // A hard barrier disables every legacy hint, external file included. Precedence is computed once
  // by a helper both legacy readers share, so this file always wins over `package.json#eslintConfig`
  // and the two legacy sources are never combined into one hint set.
  const precedence = await readLegacyEslintPrecedence(root);
  if (precedence.hardBarrier) {
    return new Set<string>();
  }

  let declaredPackageNames: ReadonlySet<string>;

  try {
    const manifest = await loadProjectManifest(root);

    declaredPackageNames = manifest.declaredDependencyNames;
  } catch (error) {
    if (error instanceof ProjectManifestError || error instanceof SourceFilesError) {
      // Manifest failures stay with the manifest loader and the analyzer, which report them as they
      // always have; this detector never duplicates that diagnosis.
      return new Set<string>();
    }

    throw error;
  }

  // Reuse the on-disk entry name when the legacy `.eslintrc.json` was found under a different
  // casing, so the reader opens the file that actually exists instead of assuming the canonical
  // lowercase spelling.
  const eslintRcFilename = precedence.legacyRcJsonEntryName ?? ESLINTRC_FILENAME;
  const eslintRcPath = join(root, eslintRcFilename);
  const text = await readEslintRcText(eslintRcPath);

  if (text === undefined) {
    return new Set<string>();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(withoutByteOrderMark(text));
  } catch (error) {
    throw new EslintRcJsonError(
      `${eslintRcFilename} at ${eslintRcPath} is not valid JSON. DepVitals reads strict JSON ` +
        `only, so JavaScript-style comments inside ${eslintRcFilename} are not supported.`,
      'invalid-json',
      error,
    );
  }

  // The whole document is the legacy config object, so the proven matcher is reused verbatim. A
  // top-level value that is not an object simply matches nothing, and nothing undeclared is added.
  return findEslintConfigUsage(parsed, declaredPackageNames);
}

/**
 * Read `.eslintrc.json` as text, returning `undefined` when there is no usable file.
 *
 * `undefined` means "no external configuration to consult": the file is absent, or it is not a
 * regular file. Anything else that prevents reading a real configuration file is an explicit error,
 * because guessing that a broken file declares nothing is how a false `unused` finding starts.
 */
async function readEslintRcText(eslintRcPath: string): Promise<string | undefined> {
  let stats;

  try {
    // `lstat`, not `stat`: a symlinked `.eslintrc.json` is not followed, so content outside the
    // analyzed project tree is never read. The path is `<root>/.eslintrc.json` built from a fixed
    // file name, so it cannot address anything outside the resolved root by construction.
    stats = await lstat(eslintRcPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw toUnreadableError(eslintRcPath, error);
  }

  // Only a regular file is read: a directory, FIFO, socket or symlink contributes no evidence.
  if (!stats.isFile()) {
    return undefined;
  }

  try {
    return await readFile(eslintRcPath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      // The file disappeared between the two calls: that is an absent configuration, not a broken one.
      return undefined;
    }

    throw toUnreadableError(eslintRcPath, error);
  }
}

/**
 * Remove a leading UTF-8 BOM, which `readFile(..., 'utf8')` keeps verbatim.
 *
 * A BOM is an encoding artifact of the same JSON document rather than a different configuration
 * format, so it must not turn a readable configuration into an `invalid-json` failure.
 */
function withoutByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Wrap a filesystem failure on a real `.eslintrc.json` file as an operational error.
 */
function toUnreadableError(eslintRcPath: string, error: unknown): EslintRcJsonError {
  return new EslintRcJsonError(
    `Could not read ${ESLINTRC_FILENAME} at ${eslintRcPath}`,
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
