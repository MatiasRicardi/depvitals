/**
 * Focused coverage for the CLI entry sequencing (Step 67).
 *
 * The entry layer owns exactly three observable promises, and every test below is about one of them:
 *
 * 1. **order**: the deterministic report goes out first, and the optional notice can only be appended
 *    afterwards, on stderr;
 * 2. **channels**: stdout receives the report bytes and nothing else, stderr receives the operational
 *    diagnostic plus, at most, the notice;
 * 3. **status**: the returned exit code is `runCli`'s and cannot be moved by the notifier - clean 0,
 *    findings 1, operational error 1, help/version 0 - even when the notifier misbehaves.
 *
 * The pre-change report bytes are asserted twice on purpose: once against the literal text pinned by
 * the Step 62 gate, and once against the pure `runCli` result of the same invocation, so a change in
 * the report, in the reporter or in the CLI categories cannot pass this file silently.
 *
 * These tests are offline by construction. The notifier seam is injected wherever a notice exists,
 * and where the production collector is exercised it is only for invocations that eligibility rejects
 * before any I/O - with the global `fetch` additionally stubbed, so "no request happened" is asserted
 * rather than assumed, and no real user cache directory is read or written.
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CliResult, runCli } from '../../../src/cli/runCli.js';
import { type StreamWriter, runCliEntry } from '../../../src/cli/entry.js';
import type { UpdateNoticeRequest } from '../../../src/cli/notifier/updateCheck.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ANALYSIS_FIXTURES = join(REPO_ROOT, 'test', 'fixtures', 'analysis');
const MANIFEST_FIXTURES = join(REPO_ROOT, 'test', 'fixtures', 'manifest');

/** The version handed to the CLI; distinct from any published version, so forwarding is visible. */
const VERSION = '9.9.9';

/** The clean report bytes as of Step 62, i.e. before the notifier existed. */
const CLEAN_REPORT = 'DepVitals\n\nNo dependency issues found.\n';

/** The findings report bytes as of Step 62, i.e. before the notifier existed. */
const FINDINGS_REPORT =
  'DepVitals\n\nUnused devDependencies (1)\n  moment\n\nMissing dependencies (1)\n  zod\n';

/** A notice in the exact shape the notifier produces. */
const NOTICE = `\nNew DepVitals version available: ${VERSION} -> 0.2.0\nRun: npx depvitals@latest\n`;

/** One recorded stream write, so the ordering of the two channels is observable. */
type Write = { readonly stream: 'stdout' | 'stderr'; readonly text: string };

/** The two injected streams and every write they received, in order. */
type Harness = {
  readonly writes: readonly Write[];
  readonly stdout: StreamWriter;
  readonly stderr: StreamWriter;
};

/** A stream pair with controllable interactivity flags; both are interactive by default. */
function makeStreams(
  tty: { stdout: boolean; stderr: boolean } = { stdout: true, stderr: true },
): Harness {
  const writes: Write[] = [];

  return {
    writes,
    stdout: {
      isTTY: tty.stdout,
      write: (chunk: string) => {
        writes.push({ stream: 'stdout', text: chunk });
      },
    },
    stderr: {
      isTTY: tty.stderr,
      write: (chunk: string) => {
        writes.push({ stream: 'stderr', text: chunk });
      },
    },
  };
}

/** A notifier stub: it records the request it received and returns the given notice. */
function makeNotice(notice: string | undefined): {
  readonly requests: readonly UpdateNoticeRequest[];
  readonly updateNotice: (request: UpdateNoticeRequest) => Promise<string | undefined>;
} {
  const requests: UpdateNoticeRequest[] = [];

  return {
    requests,
    updateNotice: (request: UpdateNoticeRequest) => {
      requests.push(request);
      return Promise.resolve(notice);
    },
  };
}

/** Run one invocation through the entry layer with injected streams and an injected notifier seam. */
async function run(
  argv: readonly string[],
  overrides: {
    readonly streams?: Harness;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly updateNotice?: (request: UpdateNoticeRequest) => Promise<string | undefined>;
  } = {},
): Promise<{ readonly exitCode: number; readonly writes: readonly Write[] }> {
  const streams = overrides.streams ?? makeStreams();

  const exitCode = await runCliEntry(argv, {
    version: VERSION,
    cwd: tmpdir(),
    env: overrides.env ?? {},
    stdout: streams.stdout,
    stderr: streams.stderr,
    ...(overrides.updateNotice === undefined ? {} : { updateNotice: overrides.updateNotice }),
  });

  return { exitCode, writes: streams.writes };
}

/** Join everything one channel received, in order. */
function textOf(writes: readonly Write[], stream: 'stdout' | 'stderr'): string {
  return writes
    .filter((write) => write.stream === stream)
    .map((write) => write.text)
    .join('');
}

/** The untouched Step 19 orchestration for the same invocation: the pre-change behaviour. */
function baseline(argv: readonly string[]): Promise<CliResult> {
  return runCli(argv, { version: VERSION, cwd: tmpdir() });
}

describe('runCliEntry: the report is printed before the optional notice', () => {
  it('writes the clean report to stdout, then the notice to stderr, and exits 0', async () => {
    const notice = makeNotice(NOTICE);

    const outcome = await run([join(ANALYSIS_FIXTURES, 'clean')], {
      updateNotice: notice.updateNotice,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.writes).toEqual([
      { stream: 'stdout', text: CLEAN_REPORT },
      { stream: 'stderr', text: NOTICE },
    ]);
    expect(textOf(outcome.writes, 'stdout')).toBe(CLEAN_REPORT);
  });

  it('keeps findings at exit 1 and only appends the notice after the findings report', async () => {
    const notice = makeNotice(NOTICE);

    const outcome = await run([join(ANALYSIS_FIXTURES, 'basic')], {
      updateNotice: notice.updateNotice,
    });

    expect(outcome.exitCode).toBe(1);
    expect(textOf(outcome.writes, 'stdout')).toBe(FINDINGS_REPORT);
    expect(textOf(outcome.writes, 'stderr')).toBe(NOTICE);
  });

  it('writes nothing to stdout beyond the report bytes', async () => {
    const notice = makeNotice(NOTICE);

    const outcome = await run([join(ANALYSIS_FIXTURES, 'basic')], {
      updateNotice: notice.updateNotice,
    });

    expect(outcome.writes.filter((write) => write.stream === 'stdout')).toHaveLength(1);
  });

  it('prints nothing when there is no notice', async () => {
    const notice = makeNotice(undefined);

    const outcome = await run([join(ANALYSIS_FIXTURES, 'clean')], {
      updateNotice: notice.updateNotice,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.writes).toEqual([{ stream: 'stdout', text: CLEAN_REPORT }]);
  });

  it('treats an empty notice as no notice at all', async () => {
    const notice = makeNotice('');

    const outcome = await run([join(ANALYSIS_FIXTURES, 'clean')], {
      updateNotice: notice.updateNotice,
    });

    expect(outcome.writes).toEqual([{ stream: 'stdout', text: CLEAN_REPORT }]);
  });
});

describe('runCliEntry: stdout and the exit status stay byte-identical to the pre-change CLI', () => {
  const invocations: readonly { label: string; argv: readonly string[] }[] = [
    { label: 'a clean scan', argv: [join(ANALYSIS_FIXTURES, 'clean')] },
    { label: 'a scan with findings', argv: [join(ANALYSIS_FIXTURES, 'basic')] },
    { label: '--help', argv: ['--help'] },
    { label: '--version', argv: ['--version'] },
    { label: 'a usage error', argv: ['--scan'] },
    { label: 'a missing manifest', argv: [MANIFEST_FIXTURES] },
    { label: 'an unanalyzable source file', argv: [join(ANALYSIS_FIXTURES, 'invalid-source')] },
  ];

  it.each(invocations)(
    '$label keeps the report, the diagnostic and the code of the pure runCli',
    async (entry) => {
      const before = await baseline(entry.argv);
      // A notifier that always has something to say, so the notice cannot hide a channel change.
      const notice = makeNotice(NOTICE);

      const outcome = await run(entry.argv, { updateNotice: notice.updateNotice });

      expect(outcome.exitCode).toBe(before.exitCode);
      expect(textOf(outcome.writes, 'stdout')).toBe(before.stdout);

      const stderr = textOf(outcome.writes, 'stderr');

      if (before.stderr.length === 0) {
        expect(stderr).toBe(NOTICE);
      } else {
        // The diagnostic keeps its exact bytes; the notice is appended after it, never before it.
        expect(stderr.startsWith(before.stderr)).toBe(true);
        expect(stderr.endsWith(NOTICE)).toBe(true);
      }
    },
  );
});

describe('runCliEntry: the notifier is told which command completed, and nothing else', () => {
  const kinds: readonly { label: string; argv: readonly string[]; commandKind: string }[] = [
    { label: 'a clean scan', argv: [join(ANALYSIS_FIXTURES, 'clean')], commandKind: 'scan' },
    {
      label: 'a scan with findings',
      argv: [join(ANALYSIS_FIXTURES, 'basic')],
      commandKind: 'scan',
    },
    { label: '--help', argv: ['--help'], commandKind: 'help' },
    { label: '--version', argv: ['--version'], commandKind: 'version' },
    { label: 'a usage error', argv: ['--scan'], commandKind: 'error' },
    { label: 'a missing manifest', argv: [MANIFEST_FIXTURES], commandKind: 'scan-failure' },
    {
      label: 'an unanalyzable source file',
      argv: [join(ANALYSIS_FIXTURES, 'invalid-source')],
      commandKind: 'scan-failure',
    },
  ];

  it.each(kinds)('classifies $label as $commandKind', async (entry) => {
    const notice = makeNotice(undefined);

    await run(entry.argv, { updateNotice: notice.updateNotice });

    expect(notice.requests).toHaveLength(1);
    expect(notice.requests[0]?.commandKind).toBe(entry.commandKind);
  });

  it('forwards the version, the environment and the two stream flags, and no project path', async () => {
    const notice = makeNotice(undefined);
    const env = { CI: '1', DEPVITALS_NO_UPDATE_CHECK: '0' };

    await run([join(ANALYSIS_FIXTURES, 'clean')], {
      env,
      updateNotice: notice.updateNotice,
    });

    const request = notice.requests[0];

    expect(request).toBeDefined();
    expect(request?.currentVersion).toBe(VERSION);
    expect(request?.env).toBe(env);
    expect(request?.stdoutTTY).toBe(true);
    expect(request?.stderrTTY).toBe(true);
    // The request has no field that could carry an analyzed path or a dependency name.
    expect(
      Object.keys(request ?? {})
        .slice()
        .sort(),
    ).toEqual(['commandKind', 'currentVersion', 'env', 'stderrTTY', 'stdoutTTY']);
  });

  it('reports a redirected stream as non-interactive on both flags', async () => {
    const notice = makeNotice(undefined);
    const streams = makeStreams({ stdout: true, stderr: false });

    await run([join(ANALYSIS_FIXTURES, 'clean')], {
      streams,
      updateNotice: notice.updateNotice,
    });

    expect(notice.requests[0]?.stdoutTTY).toBe(true);
    expect(notice.requests[0]?.stderrTTY).toBe(false);
  });
});

describe('runCliEntry: the production notifier stays silent for ineligible invocations', () => {
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Any real request would both fail loudly and be counted, so the offline claim is verifiable.
    fetchImpl = vi.fn(() => Promise.reject(new Error('these tests must not touch the network')));
    vi.stubGlobal('fetch', fetchImpl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const silent: readonly {
    label: string;
    argv: readonly string[];
    env?: Readonly<Record<string, string | undefined>>;
    tty?: { stdout: boolean; stderr: boolean };
  }[] = [
    { label: '--help', argv: ['--help'] },
    { label: '--version', argv: ['--version'] },
    { label: 'a usage error', argv: ['--scan'] },
    { label: 'a missing manifest', argv: [MANIFEST_FIXTURES] },
    {
      label: 'a clean scan',
      argv: [join(ANALYSIS_FIXTURES, 'clean')],
      env: { DEPVITALS_NO_UPDATE_CHECK: '1' },
    },
    { label: 'a clean scan in CI', argv: [join(ANALYSIS_FIXTURES, 'clean')], env: { CI: '1' } },
    {
      label: 'a scan with findings in CI',
      argv: [join(ANALYSIS_FIXTURES, 'basic')],
      env: { GITHUB_ACTIONS: 'true' },
    },
    {
      label: 'a clean scan with piped stdout',
      argv: [join(ANALYSIS_FIXTURES, 'clean')],
      tty: { stdout: false, stderr: true },
    },
    {
      label: 'a clean scan with redirected stderr',
      argv: [join(ANALYSIS_FIXTURES, 'clean')],
      tty: { stdout: true, stderr: false },
    },
  ];

  it.each(silent)('prints only the report for $label and performs no request', async (entry) => {
    const before = await baseline(entry.argv);
    const streams = entry.tty === undefined ? undefined : makeStreams(entry.tty);

    // No `updateNotice` seam: this is the wiring with the real collector, so eligibility and the
    // cache/lookup gate run for real - and must produce nothing at all here.
    const outcome = await run(entry.argv, {
      ...(entry.env === undefined ? {} : { env: entry.env }),
      ...(streams === undefined ? {} : { streams }),
    });

    expect(outcome.exitCode).toBe(before.exitCode);
    expect(textOf(outcome.writes, 'stdout')).toBe(before.stdout);
    // Nothing optional is added: neither the report channel nor the diagnostic channel changes.
    expect(textOf(outcome.writes, 'stderr')).toBe(before.stderr);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('runCliEntry: a misbehaving notifier cannot change a scan', () => {
  const misbehaviour: readonly {
    label: string;
    updateNotice: (request: UpdateNoticeRequest) => Promise<string | undefined>;
  }[] = [
    {
      label: 'a notifier that throws',
      updateNotice: () => {
        throw new Error('notifier exploded');
      },
    },
    {
      label: 'a notifier that rejects',
      updateNotice: () => Promise.reject(new Error('notifier rejected')),
    },
    {
      // Defensive: a seam that ignores its declared type must not be printed.
      label: 'a notifier that returns a non-string',
      updateNotice: (() => Promise.resolve(42)) as unknown as (
        request: UpdateNoticeRequest,
      ) => Promise<string | undefined>,
    },
  ];

  it.each(misbehaviour)('keeps the findings status for $label', async (entry) => {
    const outcome = await run([join(ANALYSIS_FIXTURES, 'basic')], {
      updateNotice: entry.updateNotice,
    });

    expect(outcome.exitCode).toBe(1);
    expect(textOf(outcome.writes, 'stdout')).toBe(FINDINGS_REPORT);
    expect(textOf(outcome.writes, 'stderr')).toBe('');
  });

  it('keeps the clean status when the notifier throws', async () => {
    const outcome = await run([join(ANALYSIS_FIXTURES, 'clean')], {
      updateNotice: () => {
        throw new Error('notifier exploded');
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.writes).toEqual([{ stream: 'stdout', text: CLEAN_REPORT }]);
  });

  it('never lets a notice turn a failed scan into a success, or the reverse', async () => {
    const failed = await run([MANIFEST_FIXTURES], {
      updateNotice: makeNotice(NOTICE).updateNotice,
    });

    expect(failed.exitCode).toBe(1);
    expect(textOf(failed.writes, 'stdout')).toBe('');
    expect(textOf(failed.writes, 'stderr')).toContain('No package.json found at');
    expect(textOf(failed.writes, 'stderr').endsWith(NOTICE)).toBe(true);
  });
});

describe('the process adapter', () => {
  /**
   * Drop comments from one of our own source files, so these assertions read the code rather than
   * prose: both files describe the rule they deliberately do not break.
   */
  function codeOnly(source: string): string {
    return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');
  }

  const INDEX_SOURCE = codeOnly(readFileSync(join(REPO_ROOT, 'src', 'cli', 'index.ts'), 'utf8'));
  const ENTRY_SOURCE = codeOnly(readFileSync(join(REPO_ROOT, 'src', 'cli', 'entry.ts'), 'utf8'));

  it('hands the package.json version to the entry layer, the only source of truth', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    };

    expect(typeof manifest.version).toBe('string');
    expect(INDEX_SOURCE).toContain('version: version');
  });

  it('assigns process.exitCode and never calls process.exit, which would truncate output', () => {
    expect(INDEX_SOURCE).toContain('process.exitCode =');
    expect(INDEX_SOURCE.includes('process.exit(')).toBe(false);
  });

  it('keeps the entry layer free of any node:process import, so streams stay injected', () => {
    expect(ENTRY_SOURCE.includes("from 'node:process'")).toBe(false);
    expect(ENTRY_SOURCE.includes('process.')).toBe(false);
    expect(ENTRY_SOURCE.includes('process.exit(')).toBe(false);
  });
});
