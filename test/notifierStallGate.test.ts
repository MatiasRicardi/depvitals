/**
 * Step 68.3 gate: a notifier transport that never answers must not change how the CLI exits.
 *
 * The Step 67 gate proves the sequencing of a notifier that *responds*. This file covers the opposite
 * case - a registry that accepts the call and stays silent - and it does so in a **real child
 * process**, because the defect it pins is invisible from inside Vitest: the runner keeps its own
 * handles alive, so a notifier deadline that cannot hold the event loop open still looks healthy
 * there. Started on its own, the same binary used to end with Node's unsettled top-level await exit
 * (`13`) and a warning on stderr, discarding the real `0`/`1` status of a scan that had already
 * printed its report.
 *
 * The contract asserted here, for every scenario below:
 *
 * - stdout stays byte-identical to the same scan with the notifier disabled;
 * - the exit code stays the scan's own `0` (clean) or `1` (findings);
 * - stderr stays empty, except for the one case that legitimately has a cached notice;
 * - at most one request reaches the single fixed endpoint, and an ineligible run makes none.
 *
 * Determinism and isolation: no real network is involved (`test/helpers/notifierFetchProbe.mjs`
 * replaces `fetch` with a recording transport that hangs on demand), the cache root is redirected
 * into a throwaway directory so the user's real cache is never read or written, and the child's
 * environment is rebuilt from scratch so an ambient `CI` flag or opt-out cannot silently turn the
 * reproduction into a no-op. The stalled transport installs no timer, socket or stdin reader, so
 * nothing but the notifier's own deadline can keep the child alive.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { NPM_DIST_TAGS_ENDPOINT } from '../src/cli/notifier/registryLookup.js';
import { UPDATE_CACHE_FILE_NAME } from '../src/cli/notifier/updateCache.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILT_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');
const PROBE = join(REPO_ROOT, 'test', 'helpers', 'notifierFetchProbe.mjs');

/** The installed version, i.e. the version a notice would compare against. */
const CURRENT_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

/** A version far above anything published, so "strictly newer" is unambiguous. */
const CANNED_LATEST = '999.999.999';

/**
 * How long the **parent** waits for a child before calling the run a failure.
 *
 * It is generous on purpose: process startup and scheduling vary across machines and platforms, and
 * a tight threshold would turn a slow runner into a false failure. It lives entirely in the parent
 * and is never inherited by the child, so it cannot keep the child alive or mask the defect.
 */
const CHILD_WATCHDOG_MS = 5000;

/** Variables that would decide eligibility before this test does. */
const INELIGIBLE_VARIABLES = new Set([
  'DEPVITALS_NO_UPDATE_CHECK',
  'DEPVITALS_TEST_FORCE_TTY',
  'DEPVITALS_TEST_STALL',
  'NODE_OPTIONS',
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
]);

/** Variables that could point the cache at the real user profile. */
const CACHE_ROOT_VARIABLES = new Set(['XDG_CACHE_HOME', 'LOCALAPPDATA', 'HOME', 'USERPROFILE']);

/** How the transport misbehaves: the request hangs, or the response body hangs. */
type StallMode = 'fetch' | 'body';

type RunOptions = {
  /** Transport behaviour; omitted means the recorder answers with the canned document. */
  readonly stall?: StallMode;
  /** Report both streams as interactive, i.e. the terminal case. */
  readonly tty?: boolean;
  /** Seed the redirected cache with this document before running. */
  readonly cache?: { readonly latest: string; readonly checkedAt: number };
  /** Extra environment on top of an otherwise eligibility-positive one. */
  readonly env?: Readonly<Record<string, string>>;
};

type RunResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Cache operations attempted by the child, including reads that leave the cache unchanged. */
  readonly cacheAccesses: readonly string[];
  /** One entry per request the child attempted. */
  readonly requests: readonly string[];
  /** Whether the parent had to kill the child, i.e. the deadline never resolved. */
  readonly timedOut: boolean;
};

/** A copy of the ambient environment with no pre-existing eligibility or cache-root decision. */
function neutralEnvironment(overrides: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !INELIGIBLE_VARIABLES.has(key.toUpperCase()) &&
      !CACHE_ROOT_VARIABLES.has(key.toUpperCase())
    ) {
      env[key] = value;
    }
  }

  return { ...env, ...overrides };
}

/**
 * Run the built CLI once with a throwaway root for the request log and the child cache.
 *
 * The child is started with `process.execPath` and an argument array (never a shell), so quoting
 * rules cannot differ between platforms.
 */
async function runObserved(argv: readonly string[], options: RunOptions): Promise<RunResult> {
  const root = await mkdtemp(join(tmpdir(), 'depvitals-step68-3-stall-'));

  try {
    const requestLog = join(root, 'requests.txt');
    const cacheLog = join(root, 'cache-accesses.txt');
    const cacheRoot = join(root, 'cache-root');

    if (options.cache !== undefined) {
      mkdirSync(join(cacheRoot, 'depvitals'), { recursive: true });
      writeFileSync(
        join(cacheRoot, 'depvitals', UPDATE_CACHE_FILE_NAME),
        JSON.stringify(options.cache),
        'utf8',
      );
    }

    const env = neutralEnvironment({
      XDG_CACHE_HOME: cacheRoot,
      LOCALAPPDATA: cacheRoot,
      HOME: join(root, 'home'),
      USERPROFILE: join(root, 'home'),
      DEPVITALS_TEST_REQUEST_FILE: requestLog,
      DEPVITALS_TEST_CACHE_ACCESS_FILE: cacheLog,
      DEPVITALS_TEST_RESPONSE_LATEST: CANNED_LATEST,
      ...(options.stall === undefined ? {} : { DEPVITALS_TEST_STALL: options.stall }),
      ...(options.tty === false ? {} : { DEPVITALS_TEST_FORCE_TTY: '1' }),
      ...options.env,
    });

    const completed = await spawnObserved(['--import', probeUrl(), BUILT_ENTRY, ...argv], env);

    const [requests, cacheAccesses] = await Promise.all([
      readTrace(requestLog),
      readTrace(cacheLog),
    ]);

    return { ...completed, requests, cacheAccesses };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The child creates a trace file only when an operation actually runs. */
async function readTrace(path: string): Promise<readonly string[]> {
  try {
    return (await readFile(path, 'utf8')).trimEnd().split('\n');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/** The probe module as a file URL, which `--import` accepts on every platform. */
function probeUrl(): string {
  return pathToFileURL(PROBE).href;
}

/**
 * Spawn one child, capture both channels, and kill it if the watchdog expires.
 *
 * A child that has to be killed is reported as `timedOut` with whatever it produced, so a hang is
 * diagnosable instead of surfacing as an opaque runner timeout.
 */
async function spawnObserved(
  argv: readonly string[],
  env: Record<string, string>,
): Promise<Omit<RunResult, 'requests' | 'cacheAccesses'>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CHILD_WATCHDOG_MS);

    child.on('error', (error) => {
      clearTimeout(watchdog);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(watchdog);
      resolve({ exitCode: code, signal, stdout, stderr, timedOut });
    });
  });
}

/** Write one throwaway project inside an existing root and return its path. */
async function makeProject(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const project = join(root, name);

  mkdirSync(project, { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify(manifest));

  return project;
}

describe('Step 68.3: a notifier that never answers cannot change the exit status', () => {
  /**
   * The two scans the matrix is built on: a clean project (exit 0) and a project with one declared
   * and unreferenced package (exit 1). Both are rebuilt per test run and removed afterwards.
   */
  const projects = {
    clean: { name: 'clean-project', manifest: { name: 'clean-project', version: '0.0.0' } },
    findings: {
      name: 'findings-project',
      manifest: {
        name: 'findings-project',
        version: '0.0.0',
        dependencies: { 'unused-pkg': '1.0.0' },
      },
    },
  } as const;

  type Scenario = keyof typeof projects;

  /** Run one scenario against a freshly created project. */
  async function run(scenario: Scenario, options: RunOptions): Promise<RunResult> {
    const root = await mkdtemp(join(tmpdir(), 'depvitals-step68-3-project-'));

    try {
      const project = await makeProject(root, projects[scenario].name, projects[scenario].manifest);

      return await runObserved([project], options);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  /** The stdout of the same scan with the notifier disabled, i.e. the baseline bytes. */
  async function baselineStdout(scenario: Scenario): Promise<string> {
    const result = await run(scenario, { env: { DEPVITALS_NO_UPDATE_CHECK: '1' } });

    expect(result.timedOut).toBe(false);

    return result.stdout;
  }

  const expectedExit: Record<Scenario, number> = { clean: 0, findings: 1 };

  describe.each(['clean', 'findings'] as const)('%s scan', (scenario) => {
    it('keeps its exit code and stays silent when the request never answers', async () => {
      const baseline = await baselineStdout(scenario);
      const result = await run(scenario, { stall: 'fetch' });

      expect(result.timedOut).toBe(false);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe(baseline);
      // Exit 13 plus an unsettled top-level await warning is the regression this pins.
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(expectedExit[scenario]);
      expect(result.requests).toEqual([NPM_DIST_TAGS_ENDPOINT]);
    });

    it('keeps its exit code and stays silent when the response body never answers', async () => {
      const baseline = await baselineStdout(scenario);
      const result = await run(scenario, { stall: 'body' });

      expect(result.timedOut).toBe(false);
      expect(result.stdout).toBe(baseline);
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(expectedExit[scenario]);
      expect(result.requests).toEqual([NPM_DIST_TAGS_ENDPOINT]);
    });

    it('refreshes an expired cache and still exits normally when the transport stalls', async () => {
      const baseline = await baselineStdout(scenario);
      const expired = { latest: CANNED_LATEST, checkedAt: Date.now() - 48 * 60 * 60 * 1000 };
      const result = await run(scenario, { stall: 'fetch', cache: expired });

      // An expired entry is a miss, so the stalled lookup runs and still may not be heard.
      expect(result.timedOut).toBe(false);
      expect(result.stdout).toBe(baseline);
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(expectedExit[scenario]);
      expect(result.requests).toEqual([NPM_DIST_TAGS_ENDPOINT]);
    });

    it('serves a fresh cache without any request even while the transport stalls', async () => {
      const baseline = await baselineStdout(scenario);
      const fresh = { latest: CANNED_LATEST, checkedAt: Date.now() };
      const result = await run(scenario, { stall: 'fetch', cache: fresh });

      expect(result.timedOut).toBe(false);
      expect(result.stdout).toBe(baseline);
      expect(result.stderr).toBe(
        `\nNew DepVitals version available: ${CURRENT_VERSION} -> ${CANNED_LATEST}\nRun: npx depvitals@latest\n`,
      );
      expect(result.exitCode).toBe(expectedExit[scenario]);
      expect(result.requests).toEqual([]);
    });

    it('makes no request at all when the user opted out', async () => {
      const baseline = await baselineStdout(scenario);
      const result = await run(scenario, {
        stall: 'fetch',
        env: { DEPVITALS_NO_UPDATE_CHECK: '1' },
      });

      expect(result.timedOut).toBe(false);
      expect(result.stdout).toBe(baseline);
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(expectedExit[scenario]);
      expect(result.requests).toEqual([]);
      expect(result.cacheAccesses).toEqual([]);
    });

    it('makes no request at all in CI', async () => {
      const baseline = await baselineStdout(scenario);
      const result = await run(scenario, { stall: 'fetch', env: { CI: 'true' } });

      expect(result.timedOut).toBe(false);
      expect(result.stdout).toBe(baseline);
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(expectedExit[scenario]);
      expect(result.requests).toEqual([]);
      expect(result.cacheAccesses).toEqual([]);
    });

    it('makes no request at all when the streams are not interactive', async () => {
      const ambientForceTty = process.env['DEPVITALS_TEST_FORCE_TTY'];
      process.env['DEPVITALS_TEST_FORCE_TTY'] = '1';

      try {
        const baseline = await baselineStdout(scenario);
        const result = await run(scenario, { stall: 'fetch', tty: false });

        expect(result.timedOut).toBe(false);
        expect(result.stdout).toBe(baseline);
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(expectedExit[scenario]);
        expect(result.requests).toEqual([]);
        expect(result.cacheAccesses).toEqual([]);
      } finally {
        if (ambientForceTty === undefined) {
          delete process.env['DEPVITALS_TEST_FORCE_TTY'];
        } else {
          process.env['DEPVITALS_TEST_FORCE_TTY'] = ambientForceTty;
        }
      }
    });
  });
}, 30_000);

describe('JSON scans and package queries bypass notifier I/O in the built CLI', () => {
  const findings = { dependencies: { 'used-pkg': '1', 'unused-pkg': '1' } };
  const source = "require('used-pkg');\n";
  const broken = "require('used-pkg');\nrequire('unfinished";
  const scenarios = [
    {
      label: 'clean JSON scan',
      args: ['--format', 'json'],
      manifest: {},
      exit: 0,
      stdout: '"mode": "scan"',
    },
    {
      label: 'JSON scan with findings',
      args: ['--format', 'json'],
      manifest: findings,
      text: source,
      exit: 1,
      stdout: '"unused-pkg"',
    },
    {
      label: 'fatal JSON scan',
      args: ['--format', 'json'],
      manifest: findings,
      text: broken,
      exit: 1,
      stderr: 'could not be analyzed',
    },
    {
      label: 'invalid JSON scan arguments',
      args: ['--format', 'json', '--unknown'],
      manifest: {},
      exit: 1,
      stderr: 'Unknown option: --unknown',
    },
    ...(['terminal', 'json'] as const).flatMap((format) => [
      {
        label: 'used query in ' + format,
        args: ['--format', format, '--explain', 'used-pkg'],
        manifest: findings,
        text: source,
        exit: 0,
        stdout: format === 'json' ? '"status": "used"' : 'Status: used\n',
      },
      {
        label: 'unused query in ' + format,
        args: ['--explain', 'unused-pkg', '--format', format],
        manifest: findings,
        text: source,
        exit: 1,
        stdout: format === 'json' ? '"status": "unused"' : 'Status: unused\n',
      },
      {
        label: 'unknown query in ' + format,
        args: ['--format', format, '--explain', 'absent'],
        manifest: {},
        exit: 1,
        stdout: format === 'json' ? '"status": "unknown"' : 'Status: unknown\n',
      },
      {
        label: 'fatal query in ' + format,
        args: ['--explain', 'used-pkg', '--format', format],
        manifest: findings,
        text: broken,
        exit: 1,
        stderr: 'could not be analyzed',
      },
      {
        label: 'invalid query in ' + format,
        args: ['--format', format, '--explain', 'used-pkg/subpath'],
        manifest: findings,
        text: source,
        exit: 1,
        stderr: 'Invalid value for --explain',
      },
    ]),
  ];

  it.each(scenarios)(
    'keeps $label isolated with both streams interactive',
    async (scenario) => {
      const scratch = await mkdtemp(join(tmpdir(), 'depvitals-notifier-isolation-'));
      try {
        const project = await makeProject(scratch, 'project', scenario.manifest);
        if ('text' in scenario) {
          await writeFile(join(project, 'index.cjs'), scenario.text);
        }
        const paths = (await readdir(project)).sort();
        const before = await Promise.all(
          paths.map((file) => readFile(join(project, file), 'utf8')),
        );
        const argv = [project, ...scenario.args];
        const baseline = await runObserved(argv, { env: { DEPVITALS_NO_UPDATE_CHECK: '1' } });
        expect(baseline).toMatchObject({
          exitCode: scenario.exit,
          signal: null,
          timedOut: false,
          requests: [],
          cacheAccesses: [],
        });
        if ('stderr' in scenario) {
          expect(baseline.stdout).toBe('');
          expect(baseline.stderr).toContain(scenario.stderr);
        } else {
          expect(baseline.stdout).toContain(scenario.stdout);
          expect(baseline.stderr).toBe('');
        }

        const fresh = { latest: CANNED_LATEST, checkedAt: Date.now() };
        const stale = { latest: CANNED_LATEST, checkedAt: Date.now() - 48 * 60 * 60 * 1000 };
        expect(await runObserved(argv, { cache: fresh, stall: 'fetch' })).toEqual(baseline);
        expect(await runObserved(argv, { cache: stale, stall: 'body' })).toEqual(baseline);
        expect((await readdir(project)).sort()).toEqual(paths);
        expect(
          await Promise.all(paths.map((file) => readFile(join(project, file), 'utf8'))),
        ).toEqual(before);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it('observes cache reads and writes for an explicit interactive terminal scan with findings', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'depvitals-notifier-control-'));
    try {
      const project = await makeProject(scratch, 'project', {
        dependencies: { 'unused-pkg': '1' },
      });
      const argv = [project, '--format', 'terminal'];
      const expected = {
        exitCode: 1,
        timedOut: false,
        signal: null,
        stdout: 'DepVitals\n\nUnused dependencies (1)\n  unused-pkg\n',
        stderr: `\nNew DepVitals version available: ${CURRENT_VERSION} -> ${CANNED_LATEST}\nRun: npx depvitals@latest\n`,
      };
      const fresh = await runObserved(argv, {
        cache: { latest: CANNED_LATEST, checkedAt: Date.now() },
        stall: 'fetch',
      });
      expect(fresh).toMatchObject({ ...expected, requests: [] });
      expect(fresh.cacheAccesses).toContain('readFile');
      expect(fresh.cacheAccesses).not.toContain('writeFile');

      const refreshed = await runObserved(argv, {
        cache: { latest: CANNED_LATEST, checkedAt: Date.now() - 48 * 60 * 60 * 1000 },
      });
      expect(refreshed).toMatchObject({ ...expected, requests: [NPM_DIST_TAGS_ENDPOINT] });
      expect(refreshed.cacheAccesses).toEqual(
        expect.arrayContaining(['readFile', 'writeFile', 'rename']),
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);
});
