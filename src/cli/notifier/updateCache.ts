/**
 * Best-effort 24-hour cache for the optional CLI update check (Step 65).
 *
 * The update-notifier contract allows **at most one** bounded public registry lookup per user per
 * day, so the version reported by a previous run is remembered in a tiny private cache file:
 *
 * ```json
 * { "latest": "0.2.1", "checkedAt": 1792170000000 }
 * ```
 *
 * Design rules, all of them derived from the contract and from the repository invariants:
 *
 * - **Outside every analyzed project.** The path is always resolved from a user-scoped environment
 *   variable or from the user's home directory, and a candidate that is not absolute is rejected.
 *   No part of the path is ever derived from the scanned directory, from `cwd`, or from any project
 *   file, so scanning a project named `depvitals` - or running from any working directory - cannot
 *   place the cache inside that project.
 * - **Minimal, private content.** Only the public `latest` version string and the timestamp of the
 *   check are stored: no project path, no manifest content, no dependency list, no credential, no
 *   machine identifier and no telemetry. The directory is created `0o700` and the file `0o600` on
 *   platforms that honor POSIX mode bits.
 * - **Untrusted on read.** Cached data is treated exactly like untrusted registry data: missing
 *   file, unreadable file, oversized file, non-regular file (including a symlink), invalid JSON,
 *   wrong types, unexpected extra keys, a negative timestamp and a timestamp in the future are all
 *   cache *misses*, never errors.
 * - **Invisible on failure.** Every filesystem operation is wrapped so that permission denied,
 *   read-only media, a missing parent directory or a failing rename resolve normally instead of
 *   throwing. Nothing here writes to stdout/stderr, and nothing here can change scan output or the
 *   process exit code.
 *
 * The module performs no network access, decides no eligibility, prints nothing and is deliberately
 * not wired into the CLI yet: the update check is assembled in Step 67, and the registry lookup
 * itself belongs to Step 66. Because both helpers are asynchronous, callers must await them so a
 * short-lived process does not exit before the cache write finishes.
 */

import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** Environment map shaped like the ambient environment, so tests can inject any values. */
export type UpdateCacheEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The freshness window. An entry is usable while its age is `>= 0` and strictly below this value;
 * an older entry is a miss, which is what allows a later step to refresh it.
 */
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Name of the cache file, exported so callers and documentation can name the exact path. */
export const UPDATE_CACHE_FILE_NAME = 'update-check.json';

/** The one environment variable consulted on Linux/macOS/other POSIX systems. */
const XDG_CACHE_HOME = 'XDG_CACHE_HOME';

/** The one environment variable consulted on Windows. */
const LOCAL_APP_DATA = 'LOCALAPPDATA';

/** Cache subdirectory added to the resolved user cache root. */
const CACHE_DIRECTORY_NAME = 'depvitals';

/** Home-directory fallback used when no usable environment variable exists: `~/.cache/depvitals`. */
const HOME_CACHE_SEGMENTS = ['.cache', CACHE_DIRECTORY_NAME] as const;

/**
 * Upper bound of the accepted cache file, in bytes. A real entry is roughly 50 bytes, so a larger
 * file cannot be our own record and is refused *before* it is read or parsed.
 */
const MAX_CACHE_BYTES = 8 * 1024;

/** Upper bound of the stored version identifier, which keeps a hostile cache file tiny. */
const MAX_VERSION_LENGTH = 64;

/**
 * Characters that can never appear in the stored identifier: whitespace, control characters, a
 * quote and a backslash. This is *not* a version grammar - exact stable-version syntax is owned by
 * `versionCompare.isNewerStableVersion`, which stays the single source of truth - it only rejects
 * values that cannot be used as an identifier and keeps the JSON record well-formed.
 */
const UNUSABLE_IDENTIFIER = /[\s"\\/]/;

/**
 * Whether `value` contains a C0/C1-in-ASCII-range control character. Written as a code-point scan
 * instead of a regex range so the lint rule against control-character patterns stays meaningful.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

/** The only mode bits requested for the cache directory and the cache file. */
const CACHE_DIRECTORY_MODE = 0o700;
const CACHE_FILE_MODE = 0o600;

/**
 * The two path dialects this module needs. Selecting `win32` or `posix` explicitly (instead of the
 * platform-dependent `node:path` default) keeps the Windows/POSIX rules correct *and* testable on
 * any operating system. Only these two members are used, so the dependency stays structural.
 */
type PathHelpers = {
  isAbsolute(candidate: string): boolean;
  join(...segments: string[]): string;
};

/** Everything that influences *where* the cache lives; all of it injectable. */
export type UpdateCacheLocationOptions = {
  /**
   * Explicit cache directory, intended for tests and for a future explicit override. Only an
   * absolute path is honored: a relative value is ignored rather than resolved against `cwd`, and
   * resolution continues with the user-scoped defaults below, which is what keeps the cache out of
   * any analyzed project.
   */
  readonly cacheDir?: string;
  /** Environment map to consult, e.g. the caller's own environment object. */
  readonly env?: UpdateCacheEnvironment;
  /** Home directory provider, defaulting to `node:os` `homedir()`. */
  readonly homedir?: () => string;
  /** Platform identifier, defaulting to `process.platform`; `'win32'` selects Windows rules. */
  readonly platform?: string;
};

/** A cache operation additionally needs the injected current time, in epoch milliseconds. */
export type UpdateCacheOptions = UpdateCacheLocationOptions & {
  /** Current time in epoch milliseconds; a non-integer or negative value disables the operation. */
  readonly now: number;
};

/** A validated cache record. */
type CacheEntry = {
  readonly latest: string;
  readonly checkedAt: number;
};

/** Where a usable cache lives. */
type Location = {
  readonly directory: string;
  readonly file: string;
};

/**
 * Whether the Windows path dialect applies. Only the exact `'win32'` platform string (the value
 * `process.platform` reports on Windows) selects it; every other platform uses POSIX rules.
 */
function isWindowsPlatform(platform: string | undefined): boolean {
  return (platform ?? process.platform) === 'win32';
}

/** The path helpers matching the platform of one call. */
function pathsFor(platform: string | undefined): PathHelpers {
  return isWindowsPlatform(platform) ? win32 : posix;
}

/**
 * Accept a directory candidate only when it is a non-empty absolute path. Relative values - which
 * would silently be resolved against the current working directory, and therefore possibly inside
 * the project being scanned - are rejected here, and a rejected location turns into a cache miss.
 */
function absoluteOnly(candidate: string | undefined, paths: PathHelpers): string | undefined {
  if (candidate === undefined || candidate === '') {
    return undefined;
  }

  return paths.isAbsolute(candidate) ? candidate : undefined;
}

/**
 * Read the home directory from the injected provider, or from `node:os`. A provider that throws or
 * returns an empty/relative value yields no usable location.
 */
function homeOnly(options: UpdateCacheLocationOptions, paths: PathHelpers): string | undefined {
  let reported: string | undefined;

  try {
    reported = options.homedir?.() ?? homedir();
  } catch {
    // An unavailable home directory is a normal situation (locked-down or daemon accounts).
    return undefined;
  }

  return absoluteOnly(reported, paths);
}

/**
 * Resolve the user-scoped cache *directory* for the platform:
 *
 * - Windows: absolute `LOCALAPPDATA` + `depvitals`;
 * - otherwise: absolute `XDG_CACHE_HOME` + `depvitals`;
 * - fallback on every platform: `<home>/.cache/depvitals`.
 *
 * Environment variables are consulted by exact name, are only accepted when absolute, and never
 * fall back to the analyzed project.
 */
function cacheDirectory(
  options: UpdateCacheLocationOptions,
  paths: PathHelpers,
): string | undefined {
  const override = absoluteOnly(options.cacheDir, paths);

  if (override !== undefined) {
    return override;
  }

  const env = options.env ?? {};

  if (isWindowsPlatform(options.platform)) {
    const localAppData = absoluteOnly(env[LOCAL_APP_DATA], paths);

    if (localAppData !== undefined) {
      return paths.join(localAppData, CACHE_DIRECTORY_NAME);
    }
  } else {
    const xdgCacheHome = absoluteOnly(env[XDG_CACHE_HOME], paths);

    if (xdgCacheHome !== undefined) {
      return paths.join(xdgCacheHome, CACHE_DIRECTORY_NAME);
    }
  }

  const home = homeOnly(options, paths);

  if (home === undefined) {
    return undefined;
  }

  return paths.join(home, ...HOME_CACHE_SEGMENTS);
}

/**
 * Resolve the usable cache directory and the cache file inside it, or `undefined` when no safe
 * location exists (no usable environment variable and no absolute home directory, or a relative
 * `cacheDir`). Neither result ever depends on the scanned directory or on `cwd`.
 */
function resolveLocation(options: UpdateCacheLocationOptions): Location | undefined {
  const paths = pathsFor(options.platform);
  const directory = cacheDirectory(options, paths);

  if (directory === undefined) {
    return undefined;
  }

  return { directory, file: paths.join(directory, UPDATE_CACHE_FILE_NAME) };
}

/**
 * Resolve the absolute path of the cache file, or `undefined` when no safe location exists, i.e.
 * when no usable cache environment variable and no absolute home directory is available. A
 * relative `cacheDir` is ignored in favor of those user-scoped defaults. The result never depends
 * on the scanned directory or on `cwd`.
 *
 * @param options - Location inputs (override directory, environment map, home provider, platform).
 * @returns The absolute cache file path, or `undefined` when caching is impossible.
 */
export function resolveUpdateCacheFile(
  options: UpdateCacheLocationOptions = {},
): string | undefined {
  return resolveLocation(options)?.file;
}

/**
 * Whether the injected clock is usable. A fractional, `NaN`, infinite, negative or absurdly large
 * value cannot establish freshness, so it disables the operation instead of guessing.
 */
function isUsableClock(now: number): boolean {
  return Number.isSafeInteger(now) && now >= 0;
}

/** Whether a string can serve as the stored version identifier. See `UNUSABLE_IDENTIFIER`. */
function isUsableIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_VERSION_LENGTH &&
    !hasControlCharacter(value) &&
    !UNUSABLE_IDENTIFIER.test(value)
  );
}

/**
 * Read at most a bounded amount of text from the cache file.
 *
 * `lstat` (not `stat`) is used deliberately: the entry must be a regular file, so a symlink planted
 * at the cache path - a path this module does not control on shared systems - is a miss, and its
 * target is never read. A directory, an oversized file and any I/O error also end up as `undefined`.
 */
async function readCacheText(file: string): Promise<string | undefined> {
  const info = await lstat(file);

  if (!info.isFile() || info.size > MAX_CACHE_BYTES) {
    return undefined;
  }

  const contents = await readFile(file, 'utf8');

  // Decoded length is not byte length, so re-check the bound before parsing anything.
  return contents.length > MAX_CACHE_BYTES ? undefined : contents;
}

/**
 * Validate one cached document. The document must be a JSON object carrying exactly `latest` (a
 * usable identifier) and `checkedAt` (a non-negative safe integer); arrays, scalars, invalid JSON,
 * wrong types and unexpected extra keys are all rejected.
 */
function parseCacheEntry(contents: string): CacheEntry | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Readonly<Record<string, unknown>>;

  if (Object.keys(record).length !== 2) {
    return undefined;
  }

  const latest = record['latest'];
  const checkedAt = record['checkedAt'];

  if (!isUsableIdentifier(latest)) {
    return undefined;
  }

  if (typeof checkedAt !== 'number' || !Number.isSafeInteger(checkedAt) || checkedAt < 0) {
    return undefined;
  }

  return { latest, checkedAt };
}

/**
 * Look up a fresh cached `latest` version.
 *
 * Returns the cached string only when the record exists, is valid, and its age is `>= 0` and below
 * {@link UPDATE_CACHE_TTL_MS}. Every other case - no file, invalid or oversized content, wrong
 * types, an extra key, a negative or future timestamp, a permission error, a symlink, a locked-down
 * home folder - returns `undefined`, i.e. a miss. This function never throws and never logs, so a
 * broken cache can never change a scan.
 *
 * @param options - The injected clock plus the cache location inputs.
 * @returns The cached `latest` version, or `undefined` when the cache must be treated as empty.
 */
export async function readCachedLatest(options: UpdateCacheOptions): Promise<string | undefined> {
  try {
    if (!isUsableClock(options.now)) {
      return undefined;
    }

    const file = resolveUpdateCacheFile(options);

    if (file === undefined) {
      return undefined;
    }

    const text = await readCacheText(file);

    if (text === undefined) {
      return undefined;
    }

    const entry = parseCacheEntry(text);

    if (entry === undefined) {
      return undefined;
    }

    // A future timestamp means the clock or the file cannot be trusted: refresh, do not guess.
    const age = options.now - entry.checkedAt;

    if (age < 0 || age >= UPDATE_CACHE_TTL_MS) {
      return undefined;
    }

    return entry.latest;
  } catch {
    // A missing file (ENOENT) and every other filesystem failure are ordinary cache misses.
    return undefined;
  }
}

/**
 * Serialize the whole cache document: exactly the two contract-approved fields, nothing else.
 */
function serializeEntry(latest: string, checkedAt: number): string {
  const entry: CacheEntry = { latest, checkedAt };

  return JSON.stringify(entry);
}

/**
 * Remove a temporary file without ever reporting a failure.
 */
async function removeQuietly(target: string): Promise<void> {
  try {
    await rm(target, { force: true });
  } catch {
    // Nothing to clean up, or the media refuses it; either way the scan is unaffected.
  }
}

/**
 * Stage the record in a sibling temporary file and rename it into place, so a concurrent reader -
 * or a crash in the middle of a write - never observes a half-written JSON document. The temporary
 * name carries the process id, so simultaneous DepVitals processes do not share a staging file, and
 * `rename` replaces the previous entry atomically on POSIX and on Windows.
 *
 * All failures are swallowed: a read-only, missing or unwritable cache directory simply means the
 * next run repeats its lookup.
 */
async function writeAtomically(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${String(process.pid)}.tmp`;

  try {
    await writeFile(temporary, contents, { mode: CACHE_FILE_MODE });
    await rename(temporary, file);
  } catch {
    // Permission denied, read-only media or a vanished parent directory: skip caching silently.
  } finally {
    // After a successful rename the temporary name no longer exists, so this is a no-op.
    await removeQuietly(temporary);
  }
}

/**
 * Record a `latest` version together with the injected current time.
 *
 * The write is best effort and completely silent: it creates the cache directory if needed
 * (`0o700`), stages the file (`0o600`) and renames it into place, and it resolves normally even when
 * nothing at all could be written. Only the two contract-approved fields are serialized.
 *
 * @param latest - The public `latest` version string to remember; anything whitespace/control-bearing,
 *   empty or longer than 64 characters is not written.
 * @param options - The injected clock plus the cache location inputs.
 */
export async function writeCachedLatest(
  latest: string,
  options: UpdateCacheOptions,
): Promise<void> {
  try {
    if (!isUsableClock(options.now) || !isUsableIdentifier(latest)) {
      return;
    }

    const location = resolveLocation(options);

    if (location === undefined) {
      return;
    }

    // Creating the directory is part of the best-effort path: a home folder that cannot hold a
    // cache directory simply results in no cache, exactly like a later failing write.
    await mkdir(location.directory, { recursive: true, mode: CACHE_DIRECTORY_MODE });
    await writeAtomically(location.file, serializeEntry(latest, options.now));
  } catch {
    // `mkdir` is the only call here that can still throw; caching is skipped silently.
  }
}
