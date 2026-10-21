/**
 * Step 67 gate: the assembled update notifier against the **built** CLI, with real argv.
 *
 * `test/unit/cli/entry.test.ts` proves the sequencing rule with injected streams; this file proves the
 * same rules for the artifact users actually run - `dist/cli/index.js` started with real argv - using
 * the two guarantees the contract cares about:
 *
 * - stdout carries the report and nothing else, byte for byte, computed from `analyzeProject` plus
 *   `formatTerminalReport`, and the exit status stays clean `0` / findings `1` / operational error
 *   `1` / help `0` / version `0`;
 * - the notice is stderr-only, and the check is bounded: eligibility first, then the fresh cache, then
 *   at most one request to one fixed public endpoint.
 *
 * The network is not involved. `test/helpers/notifierFetchProbe.mjs` replaces the global `fetch` with a
 * recording transport that either answers with a canned dist-tag document or fails loudly, and it can
 * report the child's streams as interactive so that an eligibility-positive run is possible while its
 * output is still captured over a pipe. A run with a poisoned transport proves the degradation path:
 * the report, the status and stderr all stay exactly as they were.
 *
 * The cache root is redirected into a throwaway directory through `XDG_CACHE_HOME` / `LOCALAPPDATA`, so
 * these tests never read or write the real user cache - and the scanned project itself is compared
 * file-by-file before and after, because a normal scan must still not create anything.
 *
 * CI runs the test job before the build job, so - exactly like the Step 62 gate - the process-level
 * cases below only apply once `pnpm run build` has produced `dist/`.
 */

import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { NPM_DIST_TAGS_ENDPOINT } from '../src/cli/notifier/registryLookup.js';
import { UPDATE_CACHE_FILE_NAME } from '../src/cli/notifier/updateCache.js';
import { runCli } from '../src/cli/runCli.js';
import { analyzeProject } from '../src/core/analyzeProject.js';
import { formatTerminalReport } from '../src/reporters/terminalReporter.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUNNER = process.execPath;
const BUILT_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');
const PROBE = join(REPO_ROOT, 'test', 'helpers', 'notifierFetchProbe.mjs');
const ANALYSIS_FIXTURES = join(REPO_ROOT, 'test', 'fixtures', 'analysis');
const MANIFEST_FIXTURES = join(REPO_ROOT, 'test', 'fixtures', 'manifest');

/**
 * Newest modification time inside a directory tree, used as the freshness signal for `dist/`.
 * Unreadable entries are ignored; an empty tree reports 0.
 */
function newestMtime(directory: string): number {
  let newest = 0;

  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const parent = isAbsolute(entry.parentPath)
      ? entry.parentPath
      : join(directory, entry.parentPath);
    const time = statSync(join(parent, entry.name)).mtimeMs;

    if (time > newest) {
      newest = time;
    }
  }

  return newest;
}

/**
 * Build the CLI when `dist/` is absent or older than `src/`.
 *
 * `pnpm run check` (and CI) run the tests before the build step, so a plain existence check would let
 * this gate silently exercise a stale artifact that predates the notifier wiring under test. Building
 * here keeps the promise of the file honest on a fresh clone as well as on a dirty worktree. A build
 * that still leaves no usable entry point is reported instead of degrading into a skipped gate.
 */
function ensureBuiltCli(): void {
  const entryTime = existsSync(BUILT_ENTRY) ? statSync(BUILT_ENTRY).mtimeMs : 0;

  if (entryTime >= newestMtime(join(REPO_ROOT, 'src'))) {
    return;
  }

  const build = spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  if (!existsSync(BUILT_ENTRY)) {
    throw new Error(
      `could not build the CLI for the notifier gate (status ${String(build.status)}): ${build.stderr.trim().slice(0, 500)}`,
    );
  }
}

ensureBuiltCli();

/** Runs against the built artifact, which {@link ensureBuiltCli} has just made current. */
const itBuilt = existsSync(BUILT_ENTRY) ? it : it.skip;

/** The version in package.json, i.e. the version the notice compares against. */
const CURRENT_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

/** A version far above anything published, so "strictly newer" is unambiguous. */
const CANNED_LATEST = '999.999.999';

/** Environment variables that would decide eligibility before this test does. */
const INELIGIBLE_VARIABLES = new Set(['CI', 'GITHUB_ACTIONS', 'DEPVITALS_NO_UPDATE_CHECK']);

/** Environment variables that could point the cache at a real user profile. */
const CACHE_ROOT_VARIABLES = new Set(['XDG_CACHE_HOME', 'LOCALAPPDATA', 'HOME', 'USERPROFILE']);

type RunOptions = {
  /** Report the child's streams as interactive, i.e. the terminal case. */
  readonly tty?: boolean;
  /** Canned `latest` dist-tag; without it any request fails instead of resolving. */
  readonly latest?: string;
  /** Extra environment, on top of an otherwise eligibility-positive one. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** One entry per network request the child attempted. */
  readonly requests: readonly string[];
  /** Whether the child created DepVitals' own cache directory under the redirected cache root. */
  readonly cacheCreated: boolean;
  /** The cache document, when one was written. */
  readonly cache: unknown;
};

/** A copy of the ambient environment with no pre-existing eligibility or cache-root decision. */
function neutralEnvironment(overrides: RunOptions['env']): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !INELIGIBLE_VARIABLES.has(key) && !CACHE_ROOT_VARIABLES.has(key)) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

/** The environment of an observed child: request log plus a redirected cache root. */
function probeEnvironment(
  root: string,
  options: RunOptions & { readonly requestLog: string },
): Record<string, string> {
  return neutralEnvironment({
    ...options.env,
    XDG_CACHE_HOME: join(root, 'cache-root'),
    LOCALAPPDATA: join(root, 'cache-root'),
    DEPVITALS_TEST_REQUEST_FILE: options.requestLog,
    ...(options.tty === true ? { DEPVITALS_TEST_FORCE_TTY: '1' } : {}),
    ...(options.latest === undefined ? {} : { DEPVITALS_TEST_RESPONSE_LATEST: options.latest }),
  });
}

/** Read a child's request log, where an absent or empty file means "no request happened". */
async function readRequests(requestLog: string): Promise<readonly string[]> {
  const text = await readFile(requestLog, 'utf8').catch(() => '');

  return text === '' ? [] : text.split('\n').filter((line) => line !== '');
}

/**
 * Run the built CLI once inside a throwaway directory that holds both the request log and the only
 * cache root the child can see. Everything is read back before the directory disappears.
 */
async function runObserved(argv: readonly string[], options: RunOptions): Promise<RunResult> {
  const root = await mkdtemp(join(tmpdir(), 'depvitals-step67-gate-'));

  try {
    const requestLog = join(root, 'requests.txt');
    const cacheDirectory = join(root, 'cache-root', 'depvitals');
    const cacheFile = join(cacheDirectory, UPDATE_CACHE_FILE_NAME);

    const child = runChild(argv, probeEnvironment(root, { ...options, requestLog }));

    let exitCode = 0;
    let stdout = '';
    let stderr = '';

    try {
      const completed = await child;

      stdout = completed.stdout;
      stderr = completed.stderr;
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };

      exitCode = failure.code ?? -1;
      stdout = failure.stdout ?? '';
      stderr = failure.stderr ?? '';
    }

    let cache: unknown;

    if (existsSync(cacheFile)) {
      cache = JSON.parse(await readFile(cacheFile, 'utf8')) as unknown;
    }

    return {
      exitCode,
      stdout,
      stderr,
      requests: await readRequests(requestLog),
      cacheCreated: existsSync(cacheDirectory),
      cache,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Every path below a directory, sorted, so a scan's footprint is comparable. */
async function treeOf(directory: string): Promise<readonly string[]> {
  return (await readdir(directory, { recursive: true })).sort();
}

/** The notice the built CLI must print, byte for byte. */
function expectedNotice(currentVersion: string, latest: string): string {
  return `\nNew DepVitals version available: ${currentVersion} -> ${latest}\nRun: npx depvitals@latest\n`;
}

/** The deterministic report of one fixture, computed from the analysis modules. */
async function reportOf(project: string): Promise<string> {
  const result = await analyzeProject(project);

  return formatTerminalReport(result);
}

/** Run one child process with an explicit environment and capture both channels. */
async function runChild(
  argv: readonly string[],
  env: Record<string, string>,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const completed = await execFileAsync(
    RUNNER,
    ['--import', pathToFileURL(PROBE).href, BUILT_ENTRY, ...argv],
    { env, encoding: 'utf8' },
  );

  return { stdout: completed.stdout, stderr: completed.stderr };
}

/**
 * Narrow a cache document read back from disk.
 *
 * The cache is written by the child, so it is treated as untrusted input here: the assertions below
 * work on typed fields instead of on `any`.
 */
function asCacheEntry(
  value: unknown,
): { readonly latest: string; readonly checkedAt: number } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const document = value as Record<string, unknown>;

  if (typeof document['latest'] !== 'string' || typeof document['checkedAt'] !== 'number') {
    return undefined;
  }

  return { latest: document['latest'], checkedAt: document['checkedAt'] };
}

describe('Step 67 gate: the built CLI keeps the report byte-identical', () => {
  const reportCases = [
    { name: 'clean', exitCode: 0 },
    { name: 'basic', exitCode: 1 },
  ] as const;

  itBuilt.each(reportCases)(
    '$name scan: stdout is exactly the deterministic report even when a notice exists',
    async (testCase) => {
      const project = join(ANALYSIS_FIXTURES, testCase.name);

      const outcome = await runObserved([project], { tty: true, latest: CANNED_LATEST });

      expect(outcome.exitCode).toBe(testCase.exitCode);
      expect(outcome.stdout).toBe(await reportOf(project));
      // The notice never enters the report channel, not even as a separator or a trailing newline.
      expect(outcome.stdout.includes('npx depvitals@latest')).toBe(false);
      expect(outcome.stdout.endsWith('\n')).toBe(true);
      expect(outcome.stderr).toBe(expectedNotice(CURRENT_VERSION, CANNED_LATEST));
    },
  );

  itBuilt('writes nothing into the analyzed project while checking for an update', async () => {
    const project = join(ANALYSIS_FIXTURES, 'clean');
    const before = await treeOf(project);

    await runObserved([project], { tty: true, latest: CANNED_LATEST });

    expect(await treeOf(project)).toEqual(before);
  });

  itBuilt('reports help and version with the pre-notifier bytes and exit code 0', async () => {
    const help = await runObserved(['--help'], { tty: true, latest: CANNED_LATEST });
    const version = await runObserved(['--version'], { tty: true, latest: CANNED_LATEST });
    // The pure orchestration is the source of truth for the pre-notifier help bytes; the built CLI must
    // print exactly that, on stdout, with exit code 0 and an empty stderr.
    const helpBaseline = await runCli(['--help'], { version: CURRENT_VERSION, cwd: process.cwd() });

    expect({
      exitCode: help.exitCode,
      stdout: help.stdout,
      stderr: help.stderr,
    }).toEqual({
      exitCode: helpBaseline.exitCode,
      stdout: helpBaseline.stdout,
      stderr: helpBaseline.stderr,
    });
    expect(helpBaseline.exitCode).toBe(0);
    expect({ exitCode: version.exitCode, stdout: version.stdout, stderr: version.stderr }).toEqual({
      exitCode: 0,
      stdout: `${CURRENT_VERSION}\n`,
      stderr: '',
    });

    for (const outcome of [help, version]) {
      expect(outcome.requests).toEqual([]);
      expect(outcome.cacheCreated).toBe(false);
    }
  });

  itBuilt(
    'reports a usage error and an operational error without any update activity',
    async () => {
      const usage = await runObserved(['--scan'], { tty: true, latest: CANNED_LATEST });
      const failure = await runObserved([MANIFEST_FIXTURES], { tty: true, latest: CANNED_LATEST });

      expect(usage.exitCode).toBe(1);
      expect(usage.stdout).toBe('');
      // The step text paraphrases the parse failure; the parser's message is the locked contract
      // already asserted by `test/cli.test.ts` and `test/cliGate.test.ts`, so it is checked verbatim.
      expect(usage.stderr).toContain('Unknown option: --scan');
      expect(usage.stderr.includes('npx depvitals@latest')).toBe(false);

      expect(failure.exitCode).toBe(1);
      expect(failure.stdout).toBe('');
      expect(failure.stderr).toContain('No package.json found at');
      expect(failure.stderr.includes('npx depvitals@latest')).toBe(false);

      for (const outcome of [usage, failure]) {
        expect(outcome.requests).toEqual([]);
        expect(outcome.cacheCreated).toBe(false);
      }
    },
  );
});

describe('Step 67 gate: eligibility and the request bound hold for the built CLI', () => {
  const cleanProject = join(ANALYSIS_FIXTURES, 'clean');

  itBuilt(
    'makes no request and prints nothing extra when eligibility denies the check',
    async () => {
      // Denied by the environment, or denied by a non-interactive stream: in every case the request log
      // and the cache root must stay empty.
      const opted = await runObserved([cleanProject], {
        tty: true,
        env: { DEPVITALS_NO_UPDATE_CHECK: '1' },
      });
      const ci = await runObserved([cleanProject], { tty: true, env: { CI: '1' } });
      const actions = await runObserved([cleanProject], {
        tty: true,
        env: { GITHUB_ACTIONS: 'true' },
      });
      const piped = await runObserved([cleanProject], { latest: CANNED_LATEST });

      for (const outcome of [opted, ci, actions, piped]) {
        expect(outcome.exitCode).toBe(0);
        expect(outcome.stdout).toBe('DepVitals\n\nNo dependency issues found.\n');
        expect(outcome.stderr).toBe('');
        expect(outcome.requests).toEqual([]);
        expect(outcome.cacheCreated).toBe(false);
      }
    },
  );

  itBuilt('asks the fixed public endpoint once and records what it learned', async () => {
    const outcome = await runObserved([join(ANALYSIS_FIXTURES, 'basic')], {
      tty: true,
      latest: CANNED_LATEST,
    });

    expect(outcome.requests).toEqual([NPM_DIST_TAGS_ENDPOINT]);
    expect(outcome.cacheCreated).toBe(true);

    const entry = asCacheEntry(outcome.cache);

    expect(entry?.latest).toBe(CANNED_LATEST);
    expect(Number.isFinite(entry?.checkedAt ?? Number.NaN)).toBe(true);
  });

  itBuilt('serves the next run from the fresh cache without any request', async () => {
    // Two children sharing one cache root: the second must not ask again, which is the whole point of
    // the daily cache, and it must still reach the same conclusion.
    const root = await mkdtemp(join(tmpdir(), 'depvitals-step67-gate-shared-'));

    try {
      const argv = [cleanProject];
      const first = join(root, 'first.txt');
      const second = join(root, 'second.txt');
      const options: RunOptions = { tty: true, latest: CANNED_LATEST };

      const firstRun = await runChild(
        argv,
        probeEnvironment(root, { ...options, requestLog: first }),
      );
      const secondRun = await runChild(
        argv,
        probeEnvironment(root, { ...options, requestLog: second }),
      );

      expect(firstRun.stdout).toBe(await reportOf(cleanProject));
      expect(secondRun.stdout).toBe(firstRun.stdout);
      expect(secondRun.stderr).toBe(expectedNotice(CURRENT_VERSION, CANNED_LATEST));
      expect(await readRequests(first)).toEqual([NPM_DIST_TAGS_ENDPOINT]);
      expect(await readRequests(second)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  itBuilt(
    'degrades silently when the registry transport fails, keeping report and status',
    async () => {
      // No canned answer: the probe fails every request loudly. The scan must not notice.
      const clean = await runObserved([cleanProject], { tty: true });
      const findings = await runObserved([join(ANALYSIS_FIXTURES, 'basic')], { tty: true });

      expect(clean.exitCode).toBe(0);
      expect(findings.exitCode).toBe(1);
      expect(clean.stdout).toBe(await reportOf(cleanProject));
      expect(findings.stdout).toBe(await reportOf(join(ANALYSIS_FIXTURES, 'basic')));
      expect(clean.stderr).toBe('');
      expect(findings.stderr).toBe('');
      expect(clean.requests).toEqual([NPM_DIST_TAGS_ENDPOINT]);
      expect(clean.cacheCreated).toBe(false);
    },
  );

  itBuilt('prints no notice when the published version is not newer', async () => {
    const outcome = await runObserved([cleanProject], { tty: true, latest: CURRENT_VERSION });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe('');
    expect(outcome.requests).toEqual([NPM_DIST_TAGS_ENDPOINT]);
    // The negative answer is still remembered, so the next run does not ask again.
    const entry = asCacheEntry(outcome.cache);

    expect(entry?.latest).toBe(CURRENT_VERSION);
    expect(Number.isFinite(entry?.checkedAt ?? Number.NaN)).toBe(true);
  });

  itBuilt.each([
    { label: 'a prerelease payload', latest: '0.0.1-rc.1' },
    { label: 'a garbage payload', latest: 'not-a-version' },
  ])('prints no notice for $label and caches nothing', async (testCase) => {
    const outcome = await runObserved([cleanProject], { tty: true, latest: testCase.latest });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe('DepVitals\n\nNo dependency issues found.\n');
    expect(outcome.stderr).toBe('');
    expect(outcome.cacheCreated).toBe(false);
  });
});
