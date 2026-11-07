/**
 * Pure, deterministic CLI argument parsing.
 *
 * This module only validates the argument shape and resolves the selected project path. It never
 * touches the filesystem, never calls the analyzer, and never accesses `process`, so the parsing
 * rules are fully unit-testable without any I/O.
 *
 * The supported shapes are intentionally small:
 * - no arguments            -> scan the injected `cwd`
 * - exactly one positional  -> scan the resolved project directory
 * - exactly one meta flag   -> help or version (exit 0, no scan)
 * - separated format/explain options may surround the single project path
 * - malformed or unsupported shapes produce a deterministic error message
 *
 * `--help`/`-h`/`--version`/`-v` must stay standalone: combining them with any other token, or
 * combining them with each other, is rejected rather than given precedence.
 */

import { resolve } from 'node:path';
import { isExactPackageRoot } from '../config/ignoreDependencies.js';
import { escapeControlCharacters } from '../reporters/terminalReporter.js';

/** The command selected after parsing the arguments. */
export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'scan'; projectPath: string; format?: 'terminal' | 'json'; explain?: string }
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
  if (args.length === 1 && HELP_FLAGS.has(args[0] ?? '')) return { kind: 'help' };
  if (args.length === 1 && VERSION_FLAGS.has(args[0] ?? '')) return { kind: 'version' };
  const metaFlag = args.find((arg) => HELP_FLAGS.has(arg) || VERSION_FLAGS.has(arg));
  if (metaFlag !== undefined) return { kind: 'error', message: metaFlagMustBeUsedAlone(metaFlag) };

  let format: 'terminal' | 'json' | undefined;
  let explain: string | undefined;
  const paths: string[] = [];
  const error = (body: string): ParsedCommand => ({ kind: 'error', message: body + '\n' + HINT });
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--format' || arg === '--explain') {
      if (
        (arg === '--format' && format !== undefined) ||
        (arg === '--explain' && explain !== undefined)
      ) {
        return error(`Option ${arg} may be specified only once.`);
      }
      const value = args[index + 1];
      if (value === undefined || value === '' || value.startsWith('-'))
        return error(`Option ${arg} requires a value.`);
      if (arg === '--format') {
        if (value !== 'terminal' && value !== 'json')
          return error(
            `Invalid value for --format: ${escapeControlCharacters(value)}. Expected terminal or json.`,
          );
        format = value;
      } else {
        if (!isExactPackageRoot(value))
          return error(
            'Invalid value for --explain: expected an exact package root (name or @scope/name), at most 214 characters.',
          );
        explain = value;
      }
      index += 1;
    } else if (arg.startsWith('-')) return { kind: 'error', message: unknownOptionMessage(arg) };
    else paths.push(arg);
  }
  if (paths.length > 1) return { kind: 'error', message: TOO_MANY_ARGUMENTS };
  if (paths[0] === '') return { kind: 'error', message: INVALID_EMPTY_PROJECT_PATH };
  return {
    kind: 'scan',
    projectPath: paths[0] === undefined ? cwd : resolve(cwd, paths[0]),
    ...(format === undefined ? {} : { format }),
    ...(explain === undefined ? {} : { explain }),
  };
}

/**
 * The error message for an unrecognized option.
 */
function unknownOptionMessage(option: string): string {
  return `Unknown option: ${escapeControlCharacters(option)}\n${HINT}`;
}

/**
 * The error message when a meta flag is combined with additional tokens.
 */
function metaFlagMustBeUsedAlone(flag: string): string {
  return `Option ${flag} must be used alone.\n${HINT}`;
}
