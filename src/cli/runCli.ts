/**
 * Asynchronous CLI orchestration for `v0.1.0`.
 *
 * `runCli` turns parsed arguments into a plain {@link CliResult}. It performs no process I/O of its
 * own: it never writes to stdout/stderr and never touches `process`. The thin adapter in
 * `index.ts` is the only code that renders the result.
 *
 * The responsibilities here are:
 * - delegate argument validation to the pure {@link parseCliArgs};
 * - hand the configuration-only package names recognized in the project to the analyzer, which is
 *   the only component allowed to turn evidence into an unused/missing category;
 * - run the static dependency scan with `analyzeProject`;
 * - render the report with the pure terminal reporter;
 * - decide the scan exit code from `hasDependencyIssues`, not from the report string;
 * - convert operational failures into a concise CLI error result.
 *
 * It deliberately does not implement any scanning or dependency-analysis logic: that stays in
 * `src/core`, and the reporter stays in `src/reporters`.
 */

import { AnalysisError, type AnalysisResult, analyzeProject } from '../core/analyzeProject.js';
import { findEslintManifestUsage } from '../detectors/eslintManifestConfig.js';
import { formatTerminalReport, hasDependencyIssues } from '../reporters/terminalReporter.js';
import { ProjectManifestError } from '../scanner/projectManifest.js';
import { SourceFilesError } from '../scanner/sourceFiles.js';

import { parseCliArgs } from './parseCliArgs.js';

/**
 * The rendered CLI result: an exit code and the text to write to each stream. Exactly one of
 * stdout/stderr is non-empty for every command, so a successful scan never mixes a report with an
 * error and a failure never prints a misleading clean report.
 */
export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Options supplied by the process adapter. Injecting `cwd` (rather than reading `process.cwd()`)
 * keeps the orchestration pure and fully testable without mutating the working directory.
 */
export type CliOptions = {
  version: string;
  cwd: string;
};

const HELP_MESSAGE = [
  'DepVitals',
  '',
  'A simple, lightweight dependency health checker for Node.js projects.',
  '',
  'Usage:',
  '  depvitals [project]',
  '',
  'Arguments:',
  '  project          Project directory to analyze (default: current directory)',
  '',
  'Options:',
  '  -h, --help       Show help',
  '  -v, --version    Show version',
].join('\n');

/**
 * Orchestrate the CLI for the given arguments.
 *
 * @param args - The raw arguments after `node` and the script path.
 * @param options - The package version and the current working directory.
 * @returns The exit code and the stdout/stderr text to render.
 */
export async function runCli(args: readonly string[], options: CliOptions): Promise<CliResult> {
  const command = parseCliArgs(args, options.cwd);

  switch (command.kind) {
    case 'help':
      return { exitCode: 0, stdout: `${HELP_MESSAGE}\n`, stderr: '' };
    case 'version':
      return { exitCode: 0, stdout: `${options.version}\n`, stderr: '' };
    case 'error':
      return { exitCode: 1, stdout: '', stderr: `${command.message}\n` };
    case 'scan':
      return await runScan(command.projectPath);
  }
}

/**
 * Run the scan for a single project and render its report.
 *
 * Operational failures from the scanner are converted into a concise CLI error result (exit 1,
 * empty stdout). Any other thrown value is surfaced through a generic fallback message so the CLI
 * never leaks internal error objects and never leaves an unhandled rejection.
 */
async function runScan(projectPath: string): Promise<CliResult> {
  let result: AnalysisResult;

  try {
    // Legacy `package.json#eslintConfig` contributes configuration-only names. They are passed
    // through the analyzer's config handoff, which merges them into `usedNames` only, so they can
    // suppress an unused finding and can never create a missing one.
    const configUsedNames = await findEslintManifestUsage(projectPath);

    result = await analyzeProject(projectPath, { configUsedNames });
  } catch (error) {
    if (isOperationalError(error)) {
      return { exitCode: 1, stdout: '', stderr: `${error.message}\n` };
    }

    return {
      exitCode: 1,
      stdout: '',
      stderr: `${unexpectedErrorMessage(projectPath, error)}\n`,
    };
  }

  const hasIssues = hasDependencyIssues(result);

  return { exitCode: hasIssues ? 1 : 0, stdout: formatTerminalReport(result), stderr: '' };
}

/**
 * Whether the thrown value is a scanner error the CLI knows how to render. Only the existing typed
 * error classes count; everything else is treated as an unexpected internal failure.
 */
function isOperationalError(
  error: unknown,
): error is ProjectManifestError | SourceFilesError | AnalysisError {
  return (
    error instanceof ProjectManifestError ||
    error instanceof SourceFilesError ||
    error instanceof AnalysisError
  );
}

/**
 * The fallback message for an unexpected thrown value. The path is always included so the failure
 * is traceable; the underlying message is only appended when it is a non-empty, useful `Error`
 * message, so unknown throwables never leak serialized internals.
 */
function unexpectedErrorMessage(projectPath: string, error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return `Unexpected error while analyzing project ${projectPath}: ${error.message}`;
  }

  return `Unexpected error while analyzing project ${projectPath}.`;
}
