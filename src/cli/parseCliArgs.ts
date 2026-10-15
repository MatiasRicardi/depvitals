/**
 * Pure, deterministic argument parsing for the `v0.1.0` CLI.
 *
 * This module only validates the argument shape and resolves the selected project path. It never
 * touches the filesystem, never calls the analyzer, and never accesses `process`, so the parsing
 * rules are fully unit-testable without any I/O.
 *
 * The supported shapes are intentionally small:
 * - no arguments            -> scan the injected `cwd`
 * - exactly one positional  -> scan the resolved project directory
 * - exactly one meta flag   -> help or version (exit 0, no scan)
 * - anything else           -> a deterministic error message
 *
 * `--help`/`-h`/`--version`/`-v` must stay standalone: combining them with any other token, or
 * combining them with each other, is rejected rather than given precedence.
 */

import { resolve } from 'node:path';

/** The command selected after parsing the arguments. */
export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'scan'; projectPath: string }
  | { kind: 'error'; message: string };

/** Help/version flags that must be used alone. */
const HELP_FLAGS = new Set(['--help', '-h']);

/** Version flags that must be used alone. */
const VERSION_FLAGS = new Set(['--version', '-v']);

/** Hint appended to every argument error, so a failing run always points back to `--help`. */
const HINT = "Run 'depvitals --help' for available commands.";

/** Error returned when an empty string is passed as the project path. */
const INVALID_EMPTY_PROJECT_PATH = 'Invalid project path: project path must not be empty.\n' + HINT;

/** Error returned when more than one positional path is supplied. */
const TOO_MANY_ARGUMENTS = 'Too many arguments: expected at most one project path.\n' + HINT;

/**
 * Parse the raw arguments (already stripped of `node` and the script path) into a single command.
 *
 * @param args - The raw arguments after `node` and the script path.
 * @param cwd - The current working directory used as the base for relative project paths and as
 *   the default project when no argument is supplied.
 */
export function parseCliArgs(args: readonly string[], cwd: string): ParsedCommand {
  if (args.length === 0) {
    return { kind: 'scan', projectPath: cwd };
  }

  if (args.length === 1) {
    const arg = args[0];

    // An empty string (or the unreachable undefined) is an explicit, invalid positional: it must
    // not silently become `cwd`.
    if (arg === undefined || arg === '') {
      return { kind: 'error', message: INVALID_EMPTY_PROJECT_PATH };
    }

    if (HELP_FLAGS.has(arg)) {
      return { kind: 'help' };
    }

    if (VERSION_FLAGS.has(arg)) {
      return { kind: 'version' };
    }

    // Anything else that is not an option is treated as a project path.
    if (!arg.startsWith('-')) {
      return { kind: 'scan', projectPath: resolve(cwd, arg) };
    }

    return { kind: 'error', message: unknownOptionMessage(arg) };
  }

  // Two or more tokens: help/version must remain standalone, so any meta flag combined with
  // additional tokens (including other meta flags) is rejected as used alone.
  const metaFlag = args.find((arg) => HELP_FLAGS.has(arg) || VERSION_FLAGS.has(arg));
  if (metaFlag !== undefined) {
    return { kind: 'error', message: metaFlagMustBeUsedAlone(metaFlag) };
  }

  // No meta flag: reject unknown options before falling back to the positional rule, so an unknown
  // flag is reported even when it appears alongside a positional path.
  const unknownOption = args.find((arg) => arg.startsWith('-'));
  if (unknownOption !== undefined) {
    return { kind: 'error', message: unknownOptionMessage(unknownOption) };
  }

  // Remaining tokens are all positionals, which is more than one.
  return { kind: 'error', message: TOO_MANY_ARGUMENTS };
}

/**
 * The error message for an unrecognized option.
 */
function unknownOptionMessage(option: string): string {
  return `Unknown option: ${option}\n${HINT}`;
}

/**
 * The error message when a meta flag is combined with additional tokens.
 */
function metaFlagMustBeUsedAlone(flag: string): string {
  return `Option ${flag} must be used alone.\n${HINT}`;
}
