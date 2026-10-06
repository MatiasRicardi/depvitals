/**
 * Deterministic, side-effect-free CLI behavior for the `v0.0.1` bootstrap.
 *
 * The function never touches `process`: it receives the raw arguments and the package version and
 * returns a plain result object that the thin adapter renders. This keeps the argument handling
 * fully testable without mutating global process state.
 *
 * Behavior is intentionally strict for `v0.0.1`:
 * - no arguments            -> early-development message (exit 0)
 * - exactly `--help`/`-h`   -> help output (exit 0)
 * - exactly `--version`/`-v`-> version output (exit 0)
 * - anything else           -> error (exit 1)
 */

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const EARLY_DEVELOPMENT_MESSAGE = [
  'DepVitals',
  '',
  'A simple, lightweight dependency health checker for Node.js projects.',
  '',
  'Early development release.',
  'Run `depvitals --help` for available commands.',
].join('\n');

const HELP_MESSAGE = [
  'DepVitals',
  '',
  'A simple, lightweight dependency health checker for Node.js projects.',
  '',
  'Usage:',
  '  depvitals [options]',
  '',
  'Options:',
  '  -h, --help     Show help',
  '  -v, --version  Show version',
].join('\n');

const PRODUCT_NAME = 'depvitals';

/**
 * Render the early-development message shown when no argument is provided.
 */
function renderEarlyDevelopment(): CliResult {
  return {
    exitCode: 0,
    stdout: `${EARLY_DEVELOPMENT_MESSAGE}\n`,
    stderr: '',
  };
}

/**
 * Render the help output.
 */
function renderHelp(): CliResult {
  return {
    exitCode: 0,
    stdout: `${HELP_MESSAGE}\n`,
    stderr: '',
  };
}

/**
 * Render the package version. The version is passed in so the source of truth stays in
 * `package.json` and is never duplicated as a hard-coded constant.
 */
function renderVersion(version: string): CliResult {
  return {
    exitCode: 0,
    stdout: `${version}\n`,
    stderr: '',
  };
}

/**
 * Build the error result for an unsupported argument or combination.
 */
function renderUnknownOption(option: string): CliResult {
  const stderr = [
    `Unknown option: ${option}`,
    `Run '${PRODUCT_NAME} --help' for available commands.`,
  ].join('\n');
  return {
    exitCode: 1,
    stdout: '',
    stderr: `${stderr}\n`,
  };
}

/**
 * Entry point for CLI argument handling.
 *
 * @param args - The raw arguments (already stripped of `node` and the script path).
 * @param version - The package version read from `package.json`.
 */
export function runCli(args: readonly string[], version: string): CliResult {
  if (args.length === 0) {
    return renderEarlyDevelopment();
  }

  if (args.length === 1) {
    switch (args[0]) {
      case '--help':
      case '-h':
        return renderHelp();
      case '--version':
      case '-v':
        return renderVersion(version);
    }
  }

  // Exactly one argument was expected for a flag; anything else (extra tokens, combinations,
  // positional paths, unknown flags) is unsupported for `v0.0.1`.
  const firstUnknown = args.find((argument) => !isKnownFlag(argument));
  return renderUnknownOption(firstUnknown ?? args.join(' '));
}

/**
 * Whether a single argument is one of the flags supported by `v0.0.1`.
 */
function isKnownFlag(argument: string): boolean {
  return (
    argument === '--help' || argument === '-h' || argument === '--version' || argument === '-v'
  );
}
