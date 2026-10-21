/**
 * Process-facing CLI orchestration (Step 67).
 *
 * `runCliEntry` is the layer between the pure {@link runCli} orchestration and the real process
 * streams. It owns exactly three things:
 *
 * 1. render the deterministic result: stdout first, then stderr, byte for byte as `runCli` produced
 *    them - the report and the operational diagnostics are untouched by this module;
 * 2. run the *optional* update check **after** that output, and append its notice to stderr only;
 * 3. hand back the original exit code.
 *
 * The ordering above is the contract: a scan always finishes printing before the notifier may write,
 * and the notifier can never rewrite, delay or contradict that output. It also cannot change the exit
 * status, because the returned code comes from `runCli` alone and the notice is only appended text.
 *
 * Nothing here reads `process`: the streams, the environment, the working directory and the notifier
 * are all injected, so the sequencing is testable without spawning anything and without network
 * access. The thin executable adapter in `index.ts` supplies the real process objects and assigns
 * `process.exitCode` **after** this function resolves, which is what keeps the optional asynchronous
 * work from being truncated (and `process.exit()` is never called at all).
 *
 * The command kind handed to the notifier is deliberately only a literal string: no project path,
 * manifest content or dependency name ever crosses into notifier code.
 */

import {
  collectUpdateNotice,
  type UpdateNoticeCollector,
  type UpdateNoticeRequest,
} from './notifier/updateCheck.js';
import { parseCliArgs } from './parseCliArgs.js';
import { type CliOptions, type CliResult, runCli } from './runCli.js';

/**
 * The minimal stream view this layer needs: a writable text sink plus its interactivity flag.
 * `process.stdout` and `process.stderr` satisfy it, and a test double satisfies it too, which keeps
 * the TTY gate injectable without ever faking a real terminal.
 */
export type StreamWriter = {
  readonly isTTY?: boolean | undefined;
  write(chunk: string): unknown;
};

/** Everything the entry layer needs from the process, injected. */
export type CliEntryOptions = CliOptions & {
  /** The environment map used for the notifier eligibility gates, e.g. `process.env`. */
  readonly env: UpdateNoticeRequest['env'];
  /** The standard output stream. */
  readonly stdout: StreamWriter;
  /** The standard error stream. */
  readonly stderr: StreamWriter;
  /**
   * Notifier seam. Defaults to the production {@link collectUpdateNotice}; tests inject a stub so
   * they stay deterministic and offline while still asserting the real sequencing and channels.
   */
  readonly updateNotice?: UpdateNoticeCollector;
};

/**
 * Render one CLI invocation and return the exit code the caller must assign to `process.exitCode`.
 *
 * @param args - The raw arguments after `node` and the script path.
 * @param options - Version, working directory, environment, the two output streams and the
 *   optional notifier seam.
 * @returns The unchanged exit code of the scan: 0 for clean/help/version, 1 for findings/errors.
 */
export async function runCliEntry(
  args: readonly string[],
  options: CliEntryOptions,
): Promise<number> {
  const result = await runCli(args, { version: options.version, cwd: options.cwd });

  // The deterministic output goes out before anything optional happens.
  if (result.stdout.length > 0) {
    options.stdout.write(result.stdout);
  }

  if (result.stderr.length > 0) {
    options.stderr.write(result.stderr);
  }

  const notice = await collectNotice(args, result, options);

  if (notice !== undefined && notice.length > 0) {
    options.stderr.write(notice);
  }

  return result.exitCode;
}

/**
 * Ask the notifier for its notice, if this invocation has one.
 *
 * The call is wrapped so that a notifier failing in any way - a thrown error, a rejected promise, a
 * malformed return value - behaves exactly like "no notice": the scan's own status and diagnostics
 * stand on their own. An unexpected type is discarded rather than printed.
 */
async function collectNotice(
  args: readonly string[],
  result: CliResult,
  options: CliEntryOptions,
): Promise<string | undefined> {
  try {
    const collect = options.updateNotice ?? collectUpdateNotice;

    const notice = await collect({
      commandKind: commandKindOf(args, options.cwd, result),
      currentVersion: options.version,
      env: options.env,
      stdoutTTY: options.stdout.isTTY === true,
      stderrTTY: options.stderr.isTTY === true,
    });

    return typeof notice === 'string' ? notice : undefined;
  } catch {
    // An optional notification never becomes a failure of its own.
    return undefined;
  }
}

/**
 * Classify the invocation in the vocabulary the eligibility predicate expects.
 *
 * The argument parser is the single source of truth for `help`, `version` and usage errors, so it is
 * consulted again here (a pure, deterministic function of the same arguments and the same working
 * directory) instead of widening {@link CliResult}, whose three keys are pinned by the contract gate.
 * A parsed `scan` is then split by what the scan produced: {@link runCli} renders a report whenever
 * the scan completed - clean or with findings - and leaves stdout empty for an operational failure,
 * so an empty report means the scan never finished and nothing may be suggested to the user.
 *
 * Only the literal kind crosses the boundary; the parsed project path stays here and is never passed
 * into notifier code.
 */
function commandKindOf(
  args: readonly string[],
  cwd: string,
  result: CliResult,
): UpdateNoticeRequest['commandKind'] {
  const command = parseCliArgs(args, cwd);

  if (command.kind !== 'scan') {
    return command.kind;
  }

  return result.stdout.length === 0 ? 'scan-failure' : 'scan';
}
