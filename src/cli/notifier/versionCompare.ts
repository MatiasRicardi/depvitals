/**
 * Pure version comparison for the optional CLI update notifier.
 *
 * The notifier may only point an interactive user at a strictly newer *stable* DepVitals release,
 * so the ordering rule here is intentionally bounded to `major.minor.patch` with decimal digits.
 * Full semver ordering (prerelease precedence such as `-rc.1` < `-rc.2`, numeric-vs-alphanumeric
 * identifiers, build metadata significance) is deliberately **not** implemented: the update-notifier
 * contract requires skipping the notification for such versions instead of inventing an unreliable
 * comparison, so every prerelease or build-tagged version is rejected conservatively.
 *
 * The module is pure by design: no filesystem, no network, no environment, no cache, no output and
 * no `semver` dependency. Untrusted strings are validated by strict pattern matching, never parsed
 * leniently, and no input can make these functions throw.
 *
 * This helper performs no eligibility decision and activates nothing; callers (later notifier code)
 * decide whether a lookup happened and whether the notice may be printed.
 */

/**
 * One strictly numeric version component: no sign, no whitespace, no exponent, no leading zeros
 * (padding is ambiguous and is not part of how npm publishes stable versions).
 */
const COMPONENT = /^(?:0|[1-9][0-9]*)$/;

/** A parsed stable version; tuple order is `major`, `minor`, `patch`. */
type ParsedVersion = readonly [major: number, minor: number, patch: number];

/**
 * Parses one numeric component, returning `undefined` when it is not strictly numeric or when its
 * value is not a safe integer (absurdly large digit strings must never be compared by floating-point
 * rounding).
 */
function parseComponent(value: string | undefined): number | undefined {
  if (value === undefined || !COMPONENT.test(value)) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Parses an exact `major.minor.patch` string.
 *
 * Returns `undefined` for a `v` prefix, empty input, whitespace, missing or extra components
 * (`0.2`, `1.2.3.4`), prerelease tags (`0.2.0-rc.1`), build metadata (`1.2.3+build.5`), partial
 * tokens (`1.x.3`), leading zeros (`01.2.3`) and any other malformed metadata.
 *
 * Exported for the notifier's own consumers (Step 66 validates untrusted registry text with this
 * single grammar) so exactly one place defines what "an exact stable DepVitals version" means.
 */
export function parseStableVersion(value: string): ParsedVersion | undefined {
  const parts = value.split('.');

  if (parts.length !== 3) {
    return undefined;
  }

  const major = parseComponent(parts[0]);
  const minor = parseComponent(parts[1]);
  const patch = parseComponent(parts[2]);

  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }

  return [major, minor, patch];
}

/**
 * Reports whether a registry `latest` version is strictly newer than the installed DepVitals
 * version, using numeric comparison in `major`, `minor`, `patch` order (never string ordering, so
 * `0.2.10` is newer than `0.2.9`).
 *
 * Returns `false` — never a notification — when the versions are equal, when `latest` is older, or
 * when either input is not an exact stable version. That includes a prerelease installed build
 * (e.g. a local `0.2.0-rc.1`), which silently skips notification rather than relying on ordering
 * this helper does not implement.
 *
 * @param current - The installed DepVitals CLI version; callers must validate untrusted strings
 *   (for example registry JSON) before passing them here.
 * @param latest - The `latest` dist-tag reported for the package.
 * @returns `true` only for a strictly newer stable `latest`; `false` for everything else.
 */
export function isNewerStableVersion(current: string, latest: string): boolean {
  const installed = parseStableVersion(current);
  const published = parseStableVersion(latest);

  if (installed === undefined || published === undefined) {
    return false;
  }

  const [installedMajor, installedMinor, installedPatch] = installed;
  const [publishedMajor, publishedMinor, publishedPatch] = published;

  if (publishedMajor !== installedMajor) {
    return publishedMajor > installedMajor;
  }

  if (publishedMinor !== installedMinor) {
    return publishedMinor > installedMinor;
  }

  return publishedPatch > installedPatch;
}
