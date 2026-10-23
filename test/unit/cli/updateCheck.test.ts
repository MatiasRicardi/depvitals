/**
 * Focused coverage for the optional update-check orchestrator (Step 67).
 *
 * The orchestrator is the place where eligibility, cache, lookup, comparison and notice text meet, so
 * these tests assert the contract order and the silence rules rather than incidental detail:
 *
 * - the positive half: a fresh cache hit produces the notice without any request; a cache miss
 *   produces **at most one** request, records the validated result and produces the notice;
 * - the silence half: an opt-out, a CI run, a non-interactive stream or a non-scan command produces
 *   zero cache activity and zero network activity, and every failed or unusable lookup - transport
 *   failure, malformed or prerelease payload, stale budget, version that is not strictly newer -
 *   resolves to "no notice" without throwing;
 * - the shape half: the notice is two tiny lines of printable ASCII on stderr's behalf, with no ANSI,
 *   no emoji and no install claim beyond running the published package;
 * - the boundary half: the module imports nothing from the analysis path, touches no stream and reads
 *   no ambient `process` output object, so it cannot be a detector and cannot alter the report.
 *
 * Nothing here reaches the network: every transport is a stub and every cache write goes into a
 * throwaway directory outside the repository and outside the real user cache.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  collectUpdateNotice,
  formatUpdateNotice,
  UPDATE_CHECK_BUDGET_MS,
  type UpdateNoticeRequest,
  type UpdateNoticeSeams,
} from '../../../src/cli/notifier/updateCheck.js';
import {
  NPM_DIST_TAGS_ENDPOINT,
  type RegistryFetch,
  type RegistryRequestInit,
  type RegistryResponse,
} from '../../../src/cli/notifier/registryLookup.js';
import {
  UPDATE_CACHE_FILE_NAME,
  UPDATE_CACHE_TTL_MS,
} from '../../../src/cli/notifier/updateCache.js';
import { extractModuleSpecifiers } from '../../../src/scanner/moduleSpecifiers.js';

/** The module source, so the "no stream, no ambient output, no analysis import" rules are asserted. */
const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../src/cli/notifier/updateCheck.ts', import.meta.url)),
  'utf8',
);

/** A fixed fake "now": 2026-10-16T13:00:00Z, in epoch milliseconds. */
const NOW = 1_792_170_000_000;

/** The installed version under test, and a strictly newer published one. */
const INSTALLED = '0.1.2';
const NEWER = '0.2.0';

/** The notice text the eligibility-positive cases must produce, byte for byte. */
const NOTICE = `\nNew DepVitals version available: ${INSTALLED} -> ${NEWER}\nRun: npx depvitals@latest\n`;

/** A fully eligible request: completed scan, both streams interactive, no CI, no opt-out. */
const REQUEST: UpdateNoticeRequest = {
  commandKind: 'scan',
  currentVersion: INSTALLED,
  env: {},
  stdoutTTY: true,
  stderrTTY: true,
};

/** A transport record: the calls it received, so "exactly once, only the fixed endpoint" is visible. */
type Stub = {
  readonly fetchImpl: RegistryFetch;
  readonly calls: readonly { endpoint: string; init: RegistryRequestInit }[];
};

/** Build a stub transport that answers with `respond`, recording every call. */
function makeFetch(respond: () => Promise<RegistryResponse>): Stub {
  const calls: { endpoint: string; init: RegistryRequestInit }[] = [];

  return {
    calls,
    fetchImpl: async (endpoint, init) => {
      calls.push({ endpoint, init });
      return await respond();
    },
  };
}

/** A 200 whose body is the JSON encoding of `value`. */
function jsonAnswer(value: unknown): () => Promise<RegistryResponse> {
  return () =>
    Promise.resolve(new Response(JSON.stringify(value), { status: 200 }) as RegistryResponse);
}

/** A transport that never settles, i.e. a registry that ignores the abort signal. */
function hangingFetch(): Stub {
  return makeFetch(() => new Promise<RegistryResponse>(() => undefined));
}

/** A 200 whose body reader never settles, i.e. a registry that answers and then goes silent. */
function hangingBodyFetch(): Stub {
  return makeFetch(() =>
    Promise.resolve({
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise<{ done: boolean; value: Uint8Array | undefined }>(() => undefined),
          cancel: () => Promise.resolve(undefined),
        }),
      },
    } as RegistryResponse),
  );
}

/** Seed a cache record directly through the cache module's own file layout. */
async function seedCache(
  cacheDir: string,
  entry: { latest: string; checkedAt: number },
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, UPDATE_CACHE_FILE_NAME), JSON.stringify(entry), 'utf8');
}

/** Run `run` inside a throwaway cache directory that never touches the real user cache. */
async function withScratchCache(run: (cacheDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'depvitals-update-check-'));

  try {
    await run(join(root, 'cache'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The cache file of a scratch directory, for the "was anything recorded" assertions. */
function cacheFile(cacheDir: string): string {
  return join(cacheDir, UPDATE_CACHE_FILE_NAME);
}

/** Read and parse the recorded cache document. */
async function readCacheDocument(cacheDir: string): Promise<unknown> {
  return JSON.parse(await readFile(cacheFile(cacheDir), 'utf8')) as unknown;
}

describe('formatUpdateNotice', () => {
  it('is the two-line notice of the contract, with one separating blank line', () => {
    expect(formatUpdateNotice('0.1.2', '0.2.0')).toBe(
      '\nNew DepVitals version available: 0.1.2 -> 0.2.0\nRun: npx depvitals@latest\n',
    );
  });

  it('stays inside printable ASCII: no ANSI, no emoji, no trailing chatter', () => {
    const notice = formatUpdateNotice(INSTALLED, '0.10.11');

    // Printable ASCII plus newlines only, checked character by character rather than by regex.
    const printable = (character: string): boolean =>
      character === '\n' || (character >= ' ' && character <= '~');

    expect(Array.from(notice, printable).every(Boolean)).toBe(true);
    expect(notice.includes('\u001B')).toBe(false);
    expect(notice.split('\n').filter((line) => line.length > 0)).toHaveLength(2);
  });

  it('claims only that a newer version exists and how to run it, never how it was installed', () => {
    const notice = formatUpdateNotice(INSTALLED, '0.2.10');

    expect(notice).toContain(`${INSTALLED} -> 0.2.10`);
    expect(notice).toContain('Run: npx depvitals@latest');
    // No install/upgrade instruction, no package-manager flag, no sudo, no lockfile claim.
    for (const claim of [
      'npm install',
      'pnpm add',
      'yarn global',
      'sudo',
      'upgraded',
      'installed',
    ]) {
      expect(notice.toLowerCase()).not.toContain(claim);
    }
  });
});

describe('collectUpdateNotice: eligibility gates run before any I/O', () => {
  const ineligible: readonly { label: string; request: UpdateNoticeRequest }[] = [
    {
      label: 'the explicit opt-out',
      request: { ...REQUEST, env: { DEPVITALS_NO_UPDATE_CHECK: '1' } },
    },
    { label: 'CI', request: { ...REQUEST, env: { CI: '1' } } },
    {
      label: 'GitHub Actions',
      request: { ...REQUEST, env: { GITHUB_ACTIONS: 'true' } },
    },
    { label: 'a piped stdout', request: { ...REQUEST, stdoutTTY: false } },
    { label: 'a redirected stderr', request: { ...REQUEST, stderrTTY: false } },
    {
      label: 'both streams non-interactive',
      request: { ...REQUEST, stdoutTTY: false, stderrTTY: false },
    },
    { label: '--help', request: { ...REQUEST, commandKind: 'help' } },
    { label: '--version', request: { ...REQUEST, commandKind: 'version' } },
    { label: 'a usage error', request: { ...REQUEST, commandKind: 'error' } },
    { label: 'a failed scan', request: { ...REQUEST, commandKind: 'scan-failure' } },
  ];

  it.each(ineligible)('does nothing at all for $label', async (entry) => {
    await withScratchCache(async (cacheDir) => {
      const stub = makeFetch(jsonAnswer({ latest: NEWER }));
      const seams: UpdateNoticeSeams = { cacheDir, fetchImpl: stub.fetchImpl, now: () => NOW };

      expect(await collectUpdateNotice(entry.request, seams)).toBeUndefined();
      // Zero network activity, and zero cache activity: the directory was never created, either.
      expect(stub.calls).toHaveLength(0);
      expect(existsSync(cacheDir)).toBe(false);
    });
  });

  it('still performs no activity when the opt-out is combined with a stale cache', async () => {
    await withScratchCache(async (cacheDir) => {
      await seedCache(cacheDir, { latest: '0.9.9', checkedAt: NOW - UPDATE_CACHE_TTL_MS - 1 });
      const stub = hangingFetch();
      const request: UpdateNoticeRequest = {
        ...REQUEST,
        env: { DEPVITALS_NO_UPDATE_CHECK: '1' },
      };

      expect(
        await collectUpdateNotice(request, { cacheDir, fetchImpl: stub.fetchImpl, now: () => NOW }),
      ).toBeUndefined();
      expect(stub.calls).toHaveLength(0);
    });
  });

  it('honors only the exact opt-out value, which is the eligibility contract, not this module', async () => {
    // `DEPVITALS_NO_UPDATE_CHECK=0` does not opt out, so the check may proceed. This case exists to
    // pin the interaction with Step 64 rather than to re-test the predicate.
    await withScratchCache(async (cacheDir) => {
      const stub = makeFetch(jsonAnswer({ latest: NEWER }));
      const request: UpdateNoticeRequest = { ...REQUEST, env: { DEPVITALS_NO_UPDATE_CHECK: '0' } };

      expect(
        await collectUpdateNotice(request, { cacheDir, fetchImpl: stub.fetchImpl, now: () => NOW }),
      ).toBe(NOTICE);
    });
  });
});

describe('collectUpdateNotice: cache before network', () => {
  it('notices from a fresh cache and performs no request', async () => {
    await withScratchCache(async (cacheDir) => {
      await seedCache(cacheDir, { latest: NEWER, checkedAt: NOW - 60_000 });
      const stub = hangingFetch();

      expect(
        await collectUpdateNotice(REQUEST, { cacheDir, fetchImpl: stub.fetchImpl, now: () => NOW }),
      ).toBe(NOTICE);
      expect(stub.calls).toHaveLength(0);
    });
  });

  it('fetches exactly once on a cache miss and records the validated result', async () => {
    await withScratchCache(async (cacheDir) => {
      const stub = makeFetch(jsonAnswer({ latest: NEWER }));

      expect(
        await collectUpdateNotice(REQUEST, { cacheDir, fetchImpl: stub.fetchImpl, now: () => NOW }),
      ).toBe(NOTICE);
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]?.endpoint).toBe(NPM_DIST_TAGS_ENDPOINT);
      expect(await readCacheDocument(cacheDir)).toEqual({ latest: NEWER, checkedAt: NOW });
    });
  });

  it('treats a cache older than the TTL as a miss and rewrites it', async () => {
    await withScratchCache(async (cacheDir) => {
      await seedCache(cacheDir, { latest: '0.9.9', checkedAt: NOW - UPDATE_CACHE_TTL_MS });
      const stub = makeFetch(jsonAnswer({ latest: NEWER }));

      expect(
        await collectUpdateNotice(REQUEST, { cacheDir, fetchImpl: stub.fetchImpl, now: () => NOW }),
      ).toBe(NOTICE);
      expect(stub.calls).toHaveLength(1);
      expect(await readCacheDocument(cacheDir)).toEqual({ latest: NEWER, checkedAt: NOW });
    });
  });

  it('does not ask the user twice for the same cached answer over a day', async () => {
    await withScratchCache(async (cacheDir) => {
      const stub = makeFetch(jsonAnswer({ latest: NEWER }));
      const seams: UpdateNoticeSeams = { cacheDir, fetchImpl: stub.fetchImpl, now: () => NOW };

      expect(await collectUpdateNotice(REQUEST, seams)).toBe(NOTICE);
      expect(await collectUpdateNotice(REQUEST, seams)).toBe(NOTICE);
      expect(stub.calls).toHaveLength(1);
    });
  });

  it('records a version that is not newer, so the next run is a cache hit too', async () => {
    await withScratchCache(async (cacheDir) => {
      const stub = makeFetch(jsonAnswer({ latest: '0.1.2' }));

      expect(
        await collectUpdateNotice(REQUEST, { cacheDir, fetchImpl: stub.fetchImpl, now: () => NOW }),
      ).toBeUndefined();
      expect(await readCacheDocument(cacheDir)).toEqual({ latest: '0.1.2', checkedAt: NOW });
    });
  });
});

describe('collectUpdateNotice: every unusable outcome is silent', () => {
  const silent: readonly { label: string; respond: () => Promise<RegistryResponse> }[] = [
    { label: 'a transport rejection', respond: () => Promise.reject(new Error('ENOTFOUND')) },
    {
      label: 'an HTTP error status',
      respond: () => Promise.resolve(new Response('', { status: 500 }) as RegistryResponse),
    },
    {
      label: 'an HTML body',
      respond: () =>
        Promise.resolve(new Response('<html>0.9.9</html>', { status: 200 }) as RegistryResponse),
    },
    { label: 'a malformed body', respond: jsonAnswer('not-an-object') },
    { label: 'a missing latest', respond: jsonAnswer({ dist: 'x' }) },
    { label: 'a prerelease latest', respond: jsonAnswer({ latest: '0.3.0-rc.1' }) },
    { label: 'a non-stable latest', respond: jsonAnswer({ latest: 'v0.3.0' }) },
  ];

  it.each(silent)('is silent for $label and caches nothing', async (entry) => {
    await withScratchCache(async (cacheDir) => {
      const stub = makeFetch(entry.respond);

      expect(
        await collectUpdateNotice(REQUEST, { cacheDir, fetchImpl: stub.fetchImpl, now: () => NOW }),
      ).toBeUndefined();
      expect(stub.calls).toHaveLength(1);
      expect(existsSync(cacheFile(cacheDir))).toBe(false);
    });
  });

  const notNewer: readonly { label: string; latest: string; current?: string }[] = [
    { label: 'equal', latest: INSTALLED },
    { label: 'older', latest: '0.0.9' },
    { label: 'a prerelease installed build', latest: NEWER, current: '0.2.0-rc.1' },
  ];

  it.each(notNewer)('is silent when the published version is $label', async (entry) => {
    await withScratchCache(async (cacheDir) => {
      const stub = makeFetch(jsonAnswer({ latest: entry.latest }));
      const request: UpdateNoticeRequest = {
        ...REQUEST,
        ...(entry.current === undefined ? {} : { currentVersion: entry.current }),
      };

      expect(
        await collectUpdateNotice(request, { cacheDir, fetchImpl: stub.fetchImpl, now: () => NOW }),
      ).toBeUndefined();
    });
  });

  it('abandons a lookup that ignores its deadline, without waiting for it', async () => {
    await withScratchCache(async (cacheDir) => {
      const stub = hangingFetch();
      const started = performance.now();

      expect(
        await collectUpdateNotice(REQUEST, {
          cacheDir,
          fetchImpl: stub.fetchImpl,
          now: () => NOW,
          budgetMs: 5,
        }),
      ).toBeUndefined();
      expect(stub.calls).toHaveLength(1);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  it('abandons a body that ignores its deadline, without waiting for it', async () => {
    await withScratchCache(async (cacheDir) => {
      const stub = hangingBodyFetch();
      const started = performance.now();

      expect(
        await collectUpdateNotice(REQUEST, {
          cacheDir,
          fetchImpl: stub.fetchImpl,
          now: () => NOW,
        }),
      ).toBeUndefined();
      expect(stub.calls).toHaveLength(1);
      // The lookup's own hard bound ends this, well inside the outer budget.
      expect(performance.now() - started).toBeLessThan(UPDATE_CHECK_BUDGET_MS);
      expect(existsSync(cacheFile(cacheDir))).toBe(false);
    });
  });

  it('settles a fast success immediately instead of waiting out the budget', async () => {
    // The deadline timer is cleared when the work wins, so a quick answer costs nothing extra.
    await withScratchCache(async (cacheDir) => {
      const stub = makeFetch(jsonAnswer({ latest: NEWER }));
      const started = performance.now();

      expect(
        await collectUpdateNotice(REQUEST, {
          cacheDir,
          fetchImpl: stub.fetchImpl,
          now: () => NOW,
          budgetMs: 1000,
        }),
      ).toBe(NOTICE);
      expect(performance.now() - started).toBeLessThan(500);
    });
  });

  it('does not raise an unhandled rejection when the work fails after the budget elapsed', async () => {
    const rejections: unknown[] = [];
    const record = (reason: unknown): void => {
      rejections.push(reason);
    };

    process.on('unhandledRejection', record);

    try {
      await withScratchCache(async (cacheDir) => {
        const stub = makeFetch(
          () =>
            new Promise<RegistryResponse>((_resolve, reject) => {
              setTimeout(() => {
                reject(new Error('late transport failure'));
              }, 30);
            }),
        );

        expect(
          await collectUpdateNotice(REQUEST, {
            cacheDir,
            fetchImpl: stub.fetchImpl,
            now: () => NOW,
            budgetMs: 1,
          }),
        ).toBeUndefined();
      });

      // Give the late rejection time to surface before the listener is removed.
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  it('caches nothing when the injected clock is unusable, because no age could be invented', async () => {
    // An unusable clock disables the cache, not the notice: the answer is still truthful, it just
    // cannot be remembered. Nothing is written, and the lookup still happens exactly once.
    await withScratchCache(async (cacheDir) => {
      const stub = makeFetch(jsonAnswer({ latest: NEWER }));

      expect(
        await collectUpdateNotice(REQUEST, { cacheDir, fetchImpl: stub.fetchImpl, now: () => -1 }),
      ).toBe(NOTICE);
      expect(stub.calls).toHaveLength(1);
      expect(existsSync(cacheFile(cacheDir))).toBe(false);
    });
  });

  it('never throws, even when a seam throws synchronously', async () => {
    const seams: UpdateNoticeSeams = {
      now: () => {
        throw new Error('clock exploded');
      },
    };

    expect(await collectUpdateNotice(REQUEST, seams)).toBeUndefined();
  });
});

describe('collectUpdateNotice: bounded and isolated by construction', () => {
  it('gives the whole optional check a short explicit budget', () => {
    expect(UPDATE_CHECK_BUDGET_MS).toBeGreaterThan(0);
    expect(UPDATE_CHECK_BUDGET_MS).toBeLessThanOrEqual(2_000);
  });

  it('imports only the four private notifier helpers and no stream, output or analysis module', () => {
    const specifiers = extractModuleSpecifiers(MODULE_SOURCE).map(
      (occurrence) => occurrence.specifier,
    );

    expect(specifiers.slice().sort()).toEqual([
      './eligibility.js',
      './registryLookup.js',
      './updateCache.js',
      './versionCompare.js',
    ]);

    // The notice is returned as data: the orchestrator owns no channel and cannot be a detector.
    for (const forbidden of [
      'node:fs',
      'node:http',
      'node:https',
      'node:tty',
      'process.stdout',
      'process.stderr',
      'console.',
      '../core/',
      '../reporters/',
      '../scanner/',
      'process.exit',
      'eval(',
      'child_process',
    ]) {
      expect(MODULE_SOURCE.includes(forbidden)).toBe(false);
    }
  });

  it('accepts no project-derived input, because the request has exactly five fields', () => {
    expect(Object.keys(REQUEST).slice().sort()).toEqual([
      'commandKind',
      'currentVersion',
      'env',
      'stderrTTY',
      'stdoutTTY',
    ]);
  });
});
