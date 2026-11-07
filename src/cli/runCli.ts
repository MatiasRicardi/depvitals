/**
 * Asynchronous CLI orchestration.
 *
 * `runCli` turns parsed arguments into a plain {@link CliResult}. It performs no process I/O of its
 * own: it never writes to stdout/stderr and never touches `process`. The thin adapter in
 * `index.ts` is the only code that renders the result.
 *
 * The responsibilities here are:
 * - delegate argument validation to the pure {@link parseCliArgs};
 * - prepare one validated root/policy/detector context for the analyzer, which alone owns findings;
 * - run one full detailed dependency scan;
 * - render the selected terminal or JSON scan/query projection;
 * - decide the scan exit code from `hasDependencyIssues`, not from the report string;
 * - convert operational failures into a concise CLI error result.
 *
 * It deliberately does not implement any scanning or dependency-analysis logic: that stays in
 * `src/core`, and the reporter stays in `src/reporters`.
 */

import { ProjectConfigError } from '../config/readProjectConfig.js';
import {
  AnalysisError,
  analyzeProjectDetailed,
  projectAnalysisResult,
  projectPackageExplanation,
} from '../core/analyzeProject.js';
import { createScanContext } from '../core/scanContext.js';
import { EslintRcJsonError } from '../detectors/eslintRcJsonConfig.js';
import {
  formatTerminalExplanation,
  formatTerminalReport,
  hasDependencyIssues,
} from '../reporters/terminalReporter.js';
import { ProjectManifestError } from '../scanner/projectManifest.js';
import { SourceFilesError } from '../scanner/sourceFiles.js';

import { formatJsonReport } from '../reporters/jsonReporter.js';
import { parseCliArgs, type ParsedCommand } from './parseCliArgs.js';

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
  '  depvitals [project] [--format terminal|json] [--explain <package>]',
  '',
  'Arguments:',
  '  project          Project directory to analyze (default: current directory)',
  '',
  'Options:',
  '  --format <format>    Output format: terminal or json (default: terminal)',
  '  --explain <package>  Explain one exact package root (default: full scan)',
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
      return await runScan(command, options.version);
  }
}

/**
 * Run the scan for a single project and render its report.
 *
 * Operational failures from the scanner are converted into a concise CLI error result (exit 1,
 * empty stdout). Any other thrown value is surfaced through a generic fallback message so the CLI
 * never leaks internal error objects and never leaves an unhandled rejection.
 */
async function runScan(
  command: Extract<ParsedCommand, { kind: 'scan' }>,
  version: string,
): Promise<CliResult> {
  const projectPath = command.projectPath;
  try {
    const context = await createScanContext(projectPath);
    const detailed = await analyzeProjectDetailed(context);
    if (command.explain !== undefined) {
      const result = projectPackageExplanation(detailed, command.explain);
      return {
        exitCode: result.exitCode,
        stdout:
          command.format === 'json'
            ? formatJsonReport({ mode: 'explain', result }, version)
            : formatTerminalExplanation(result),
        stderr: '',
      };
    }
    const result = projectAnalysisResult(detailed);
    return {
      exitCode: hasDependencyIssues(result) ? 1 : 0,
      stdout:
        command.format === 'json'
          ? formatJsonReport({ mode: 'scan', result: detailed }, version)
          : formatTerminalReport(result),
      stderr: '',
    };
  } catch (error) {
    if (isOperationalError(error)) return { exitCode: 1, stdout: '', stderr: `${error.message}\n` };
    return { exitCode: 1, stdout: '', stderr: `${unexpectedErrorMessage(projectPath, error)}\n` };
  }
}

/**
 * Whether the thrown value is a scanner error the CLI knows how to render. Only the existing typed
 * error classes plus configuration errors count; everything else is treated as an
 * unexpected internal failure.
 */
function isOperationalError(
  error: unknown,
): error is
  ProjectManifestError | SourceFilesError | AnalysisError | EslintRcJsonError | ProjectConfigError {
  return (
    error instanceof ProjectManifestError ||
    error instanceof SourceFilesError ||
    error instanceof AnalysisError ||
    error instanceof EslintRcJsonError ||
    error instanceof ProjectConfigError
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
