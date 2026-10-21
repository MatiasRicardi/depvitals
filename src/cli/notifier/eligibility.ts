/**
 * Pure eligibility predicate for the optional CLI update check (Step 64).
 *
 * The update-notifier contract allows a *newer DepVitals version* notice to be printed to stderr
 * only after a normal, completed scan in an interactive terminal. Everything before that network
 * convenience is decided here, so the gates are auditable in one place:
 *
 * 1. a completed normal scan invocation (clean **or** with findings) - not help, not version,
 *    not an argument error, not a failed scan;
 * 2. both stdout and stderr are interactive TTYs (a pipe or redirection on either stream skips);
 * 3. no reliable CI flag;
 * 4. no explicit `DEPVITALS_NO_UPDATE_CHECK=1` opt-out.
 *
 * An ineligible invocation must trigger **no** registry lookup, **no** cache read and **no**
 * notice, so this module deliberately has no imports: it touches no filesystem, no network, no
 * cache, no clock, no output stream and no ambient global state. Every input is passed in by the
 * caller (an environment map, two booleans and the command kind), which keeps the decision
 * deterministic, offline and unit-testable without any real global state.
 *
 * The decision is safe by default: anything unknown or unrecognized resolves to `false`, and no
 * input can make this function throw.
 */

/**
 * The environment map to consult, shaped exactly like the ambient environment the CLI entry point
 * already holds. Injecting it (instead of reading globals) is what makes every gate testable with
 * arbitrary, hostile or partially known values.
 */
export type NotifierEnv = Readonly<Record<string, string | undefined>>;

/**
 * What the CLI is about to do, expressed in the same vocabulary as the argument parser plus the
 * one outcome the parser cannot know:
 *
 * - `scan` - a normal scan invocation that completed (clean or with findings; findings alone set
 *   exit code 1 and stay eligible);
 * - `help` / `version` - standalone meta options that never scan;
 * - `error` - an argument error from {@link parseCliArgs}, i.e. nothing was scanned;
 * - `scan-failure` - the scan started but failed operationally, so no report was produced.
 */
export type NotifierCommandKind = 'scan' | 'help' | 'version' | 'error' | 'scan-failure';

/** Everything the decision depends on, with no implicit global reads. */
export type NotifierEligibilityInput = {
  /** Environment map to consult, e.g. the caller's own environment object. */
  readonly env: NotifierEnv;
  /**
   * Whether the standard output stream is an interactive terminal. Node reports a pipe or a
   * redirection as non-interactive (its `isTTY` flag is absent), and any falsy value here is
   * ineligible, so the caller only has to pass the stream's own flag.
   */
  readonly stdoutTTY: boolean;
  /** Whether the error output stream is an interactive terminal, with the same rule as stdout. */
  readonly stderrTTY: boolean;
  /** Which command the CLI completed. Only a completed scan can ever be eligible. */
  readonly commandKind: NotifierCommandKind;
};

/** The only supported opt-out variable; see the update-notifier contract. */
const NO_UPDATE_CHECK_VARIABLE = 'DEPVITALS_NO_UPDATE_CHECK';

/** The opt-out is honored for exactly this value and for no other. */
const NO_UPDATE_CHECK_VALUE = '1';

/**
 * The explicit list of environment variables that reliably mean "this is a non-interactive
 * continuous-integration run". Matching is by exact variable name, never by substring, so
 * unrelated variables such as `MY_CI`, `CIRCLE_CI` or `GITLAB` are ignored.
 */
const CI_VARIABLES: readonly string[] = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'TF_BUILD',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'APPVEYOR',
];

/**
 * Values that explicitly cancel a CI flag. Providers write real identifiers into these variables
 * (`CI=TeamCity`, `TF_BUILD=True`), so a value that is present, non-empty and not one of these
 * tokens counts as CI. Skipping on an unrecognized value is the conservative direction: it costs a
 * missing notice, never an unexpected request or an extra line in a CI log.
 */
const CANCELLED_VALUES: ReadonlySet<string> = new Set(['', '0', 'false', 'no', 'off']);

/**
 * Read one variable from the injected environment map.
 */
function read(env: NotifierEnv, name: string): string | undefined {
  return env[name];
}

/**
 * Whether a CI variable is present with a value that is not an explicit cancellation. Absent and
 * empty values are not CI; comparison of cancellation tokens is case-insensitive.
 */
function isSet(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  return !CANCELLED_VALUES.has(value.toLowerCase());
}

/**
 * Whether any recognized CI variable reports a CI run.
 */
function isCiRun(env: NotifierEnv): boolean {
  return CI_VARIABLES.some((name) => isSet(read(env, name)));
}

/**
 * Whether the user opted out. `DEPVITALS_NO_UPDATE_CHECK` disables the update check if and only if
 * it equals exactly `"1"`: `0`, ``, `2`, `true`, `01` and padded values do not opt out, and no
 * broader truthy handling is implemented or implied.
 */
function hasOptedOut(env: NotifierEnv): boolean {
  return read(env, NO_UPDATE_CHECK_VARIABLE) === NO_UPDATE_CHECK_VALUE;
}

/**
 * Whether the invocation is a completed normal scan. `help`, `version`, argument errors and failed
 * scans are excluded; a scan that finished with findings is included, because findings are a
 * successful deterministic result and only change the exit code.
 */
function isCompletedScan(commandKind: NotifierCommandKind): boolean {
  switch (commandKind) {
    case 'scan':
      return true;
    case 'help':
    case 'version':
    case 'error':
    case 'scan-failure':
      return false;
    default:
      // A value outside the declared union can only come from an untyped caller; unknown work is
      // not a completed scan, so the safe default applies here too.
      return false;
  }
}

/**
 * Decide whether a human interactive invocation may attempt the optional update check.
 *
 * Returns `true` only when every gate in the contract's eligibility order passes. `false` means
 * the caller must not touch the network, must not read the cache and must not print a notice.
 *
 * @param input - The injected environment map, the two stream TTY flags and the command kind.
 * @returns `true` only for an interactive, non-CI, non-opted-out completed normal scan.
 */
export function isEligibleUpdateCheck(input: NotifierEligibilityInput): boolean {
  if (!isCompletedScan(input.commandKind)) {
    return false;
  }

  // Both streams must be interactive; a pipe or redirection on either one suppresses the check.
  if (!input.stdoutTTY || !input.stderrTTY) {
    return false;
  }

  if (isCiRun(input.env)) {
    return false;
  }

  return !hasOptedOut(input.env);
}
