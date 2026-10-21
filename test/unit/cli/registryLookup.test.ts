/**
 * Focused coverage for the bounded public `latest` dist-tag lookup (Step 66).
 *
 * Every transport is injected: the tests hand `fetchLatestDepVitalsVersion` a fake `fetch` with
 * canned responses and canned failures, plus an injected abort-signal factory, so **no test performs
 * any network I/O** - no DNS resolution, no TLS handshake, no real request and no dependency on the
 * npm registry or on wall-clock latency. Responses are built with the Node built-in `Response`, which
 * exercises the real byte-stream reading path offline.
 *
 * The asserted halves of the contract are:
 *
 * - the positive half: a 200 with an exact stable `latest` string is returned verbatim, including a
 *   body split into chunks at arbitrary byte boundaries;
 * - the isolation half: every failure (HTTP status, DNS, TLS, abort, timeout, HTML, malformed JSON,
 *   missing/wrong-typed/prerelease `latest`, oversized body, body stream error) returns `null`
 *   without throwing and without writing anything;
 * - the privacy/bound half: the request is exactly the fixed dist-tag endpoint with only a timeout
 *   signal, it happens at most once (no retries), and the timeout bound cannot be loosened.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  fetchLatestDepVitalsVersion,
  MAX_UPDATE_RESPONSE_BYTES,
  NPM_DIST_TAGS_ENDPOINT,
  UPDATE_LOOKUP_MAX_TIMEOUT_MS,
  UPDATE_LOOKUP_TIMEOUT_MS,
  type RegistryFetch,
  type RegistryRequestInit,
  type RegistryResponse,
} from '../../../src/cli/notifier/registryLookup.js';

const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));

/** The module source, so the "no credentials, no logging, no ambient fetch" rules are asserted too. */
const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../src/cli/notifier/registryLookup.ts', import.meta.url)),
  'utf8',
);

/** The URL literal from the update-notifier contract, duplicated on purpose so a change breaks here. */
const CONTRACT_ENDPOINT = 'https://registry.npmjs.org/-/package/depvitals/dist-tags';

const ENCODER = new TextEncoder();

/** A 200 answer whose body is `text`, using the real streaming implementation. */
function okBody(text: string): Promise<RegistryResponse> {
  return Promise.resolve(new Response(text, { status: 200 }));
}

/** A 200 answer whose body is the JSON encoding of an arbitrary value (used for invalid shapes). */
function okJson(value: unknown): Promise<RegistryResponse> {
  return okBody(JSON.stringify(value));
}

/**
 * An answer with an arbitrary status and no body. A plain object is used deliberately: it can model
 * statuses the fetch specification itself forbids (`199`, `599`), so the status gate is exercised for
 * every out-of-range value rather than only for the constructible ones.
 */
function statusOnly(status: number): Promise<RegistryResponse> {
  const { response } = scriptedBody([ENCODER.encode('{"latest":"9.9.9"}')], { status });

  return Promise.resolve(response);
}

/** A transport that rejects, mimicking how a DNS/TLS/abort failure reaches the caller. */
function rejecting(reason: Error): Promise<RegistryResponse> {
  return Promise.reject(reason);
}

/**
 * A fake transport that records every call and delivers what `deliver` produces (a response or a
 * rejection), so "called exactly once, with exactly this URL and nothing else" is observable.
 */
function recordingFetch(deliver: () => Promise<RegistryResponse>): {
  readonly fetchImpl: RegistryFetch;
  readonly calls: readonly { endpoint: string; init: RegistryRequestInit }[];
} {
  const calls: { endpoint: string; init: RegistryRequestInit }[] = [];

  const fetchImpl: RegistryFetch = async (endpoint, init) => {
    calls.push({ endpoint, init });
    return await deliver();
  };

  return { fetchImpl, calls };
}

/**
 * A transport that never settles. `honoursSignal` mimics the built-in `fetch` (rejecting with an
 * `AbortError` when the deadline aborts); `false` models a transport that ignores its signal, which
 * the caller must still survive within the bound.
 */
function hangingFetch(honoursSignal: boolean): RegistryFetch {
  return (_endpoint, init) =>
    new Promise<RegistryResponse>((_resolve, reject) => {
      if (honoursSignal) {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }
    });
}

/** An already-aborted signal factory: the deadline is gone before the request could start. */
function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

/**
 * A hand-written body stream so early release is observable, with optional failure after `chunks`
 * is exhausted. Byte-exact chunks let the test split a multi-byte character across reads.
 */
function scriptedBody(
  chunks: readonly Uint8Array[],
  options: {
    readonly status?: number;
    readonly failure?: Error;
    readonly cancelFailure?: Error;
  } = {},
): {
  readonly response: RegistryResponse;
  readonly wasCancelled: () => boolean;
  readonly reads: () => number;
} {
  let index = 0;
  let cancelled = false;
  let readCount = 0;

  const response: RegistryResponse = {
    status: options.status ?? 200,
    body: {
      getReader() {
        return {
          async read() {
            readCount += 1;

            if (cancelled) {
              return { done: true, value: undefined };
            }

            const chunk = chunks[index];

            if (chunk === undefined) {
              if (options.failure !== undefined) {
                return Promise.reject(options.failure);
              }

              return { done: true, value: undefined };
            }

            index += 1;
            return { done: false, value: chunk };
          },
          async cancel() {
            cancelled = true;

            if (options.cancelFailure !== undefined) {
              return Promise.reject(options.cancelFailure);
            }

            return undefined;
          },
        };
      },
    },
  };

  return { response, wasCancelled: () => cancelled, reads: () => readCount };
}

/** A body of exactly `byteLength` bytes that still carries a valid `latest` field. */
function paddedBody(byteLength: number): string {
  const prefix = '{"latest":"0.2.1","pad":"';
  const suffix = '"}';
  const filler = 'x'.repeat(byteLength - prefix.length - suffix.length);

  return `${prefix}${filler}${suffix}`;
}

describe('Step 66: a successful lookup returns the validated latest version', () => {
  it('returns the exact stable version of a 200 dist-tag document', async () => {
    const { fetchImpl, calls } = recordingFetch(() => okBody('{"latest":"0.2.1"}'));

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBe('0.2.1');
    expect(calls).toHaveLength(1);
  });

  it.each(['0.0.1', '0.2.10', '1.0.0', '10.20.30'])(
    'accepts the exact stable version %s rather than only the example',
    async (latest) => {
      const { fetchImpl } = recordingFetch(() => okJson({ latest }));

      await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBe(latest);
    },
  );

  it('accepts a body split into chunks, including inside a multi-byte character', async () => {
    const payload = ENCODER.encode('{"latest":"0.2.1","publisher":"café"}');
    const splitAt = payload.indexOf(0xc3) + 1; // the lead byte of 'é', so the pair is separated

    expect(splitAt).toBeGreaterThan(0);

    const { response, wasCancelled, reads } = scriptedBody([
      payload.slice(0, splitAt),
      payload.slice(splitAt),
    ]);
    const { fetchImpl } = recordingFetch(() => Promise.resolve(response));

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBe('0.2.1');
    expect(wasCancelled()).toBe(false); // a complete small body is read, not abandoned
    expect(reads()).toBe(3); // both chunks plus the end-of-stream read: nothing is read twice
  });

  it('accepts a body that is exactly at the byte cap', async () => {
    const { fetchImpl } = recordingFetch(() => okBody(paddedBody(MAX_UPDATE_RESPONSE_BYTES)));

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBe('0.2.1');
  });
});

describe('Step 66: the request is exactly the fixed public endpoint', () => {
  it('pins the endpoint constant to the contract URL', () => {
    expect(NPM_DIST_TAGS_ENDPOINT).toBe(CONTRACT_ENDPOINT);
  });

  it('sends only the endpoint and a timeout signal, once, with nothing project-derived', async () => {
    const { fetchImpl, calls } = recordingFetch(() => okBody('{"latest":"0.2.1"}'));

    await fetchLatestDepVitalsVersion({ fetchImpl });

    expect(calls).toHaveLength(1);

    const request = calls[0];

    if (request === undefined) {
      throw new Error('expected exactly one recorded request');
    }

    expect(request.endpoint).toBe(CONTRACT_ENDPOINT);
    expect(request.endpoint).not.toMatch(/[?#]/u); // no query string: no project-derived data
    // The request carries one option and nothing else: no headers, no body, so no npm token or
    // other credential can ride along with it.
    expect(request.init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(request.init)).toEqual(['signal']);
  });

  it('uses the built-in timeout mechanism and keeps the bound inside 300-500 ms', async () => {
    expect(UPDATE_LOOKUP_TIMEOUT_MS).toBeGreaterThanOrEqual(300);
    expect(UPDATE_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(500);

    const seen: number[] = [];
    const createAbortSignal = (timeoutMs: number): AbortSignal => {
      seen.push(timeoutMs);
      return AbortSignal.timeout(timeoutMs);
    };
    const { fetchImpl } = recordingFetch(() => okBody('{"latest":"0.2.1"}'));

    await fetchLatestDepVitalsVersion({ fetchImpl, createAbortSignal });

    expect(seen).toEqual([UPDATE_LOOKUP_TIMEOUT_MS]);
  });

  it('clamps an injected timeout to the hard ceiling instead of trusting it', async () => {
    const seen: number[] = [];
    const createAbortSignal = (timeoutMs: number): AbortSignal => {
      seen.push(timeoutMs);
      return AbortSignal.timeout(timeoutMs);
    };

    for (const timeoutMs of [60_000, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { fetchImpl } = recordingFetch(() => okBody('{"latest":"0.2.1"}'));

      await expect(
        fetchLatestDepVitalsVersion({ fetchImpl, timeoutMs, createAbortSignal }),
      ).resolves.toBe('0.2.1');
    }

    expect(seen).toEqual([
      UPDATE_LOOKUP_MAX_TIMEOUT_MS,
      0,
      UPDATE_LOOKUP_TIMEOUT_MS,
      UPDATE_LOOKUP_TIMEOUT_MS,
    ]);
    expect(seen.every((value) => value <= UPDATE_LOOKUP_MAX_TIMEOUT_MS)).toBe(true);
  });
});

describe('Step 66: every transport or status failure becomes null without a retry', () => {
  it('returns null for a 500 without touching the body', async () => {
    const { response, reads, wasCancelled } = scriptedBody([ENCODER.encode('{"latest":"9.9.9"}')], {
      status: 500,
    });
    const { fetchImpl, calls } = recordingFetch(() => Promise.resolve(response));

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
    expect(reads()).toBe(0); // the status is decided before a single body byte is read
    expect(wasCancelled()).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it.each([199, 301, 401, 403, 404, 429, 502, 503, 599])(
    'returns null for the non-2xx status %i',
    async (status) => {
      const { fetchImpl } = recordingFetch(() => statusOnly(status));

      await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
    },
  );

  it('returns null when a 200 carries no body at all', async () => {
    const bodyless: RegistryResponse = { status: 200, body: null };
    const { fetchImpl } = recordingFetch(() => Promise.resolve(bodyless));

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
  });

  it.each([
    ['DNS failure', new TypeError('fetch failed')],
    ['TLS failure', new Error('unable to verify the first certificate')],
    ['TLS host mismatch', new Error('ERR_TLS_CERT_ALTNAME_INVALID')],
    ['abort', new DOMException('The operation was aborted.', 'AbortError')],
    ['connection reset', new Error('socket hang up')],
  ])('returns null for a %s', async (_label, reason) => {
    const { fetchImpl, calls } = recordingFetch(() => rejecting(reason));

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
    expect(calls).toHaveLength(1); // no retry: a failed lookup costs exactly one request
  });

  it('returns null when the transport rejects with a value that is not an Error', async () => {
    const fetchImpl = vi.fn<RegistryFetch>().mockRejectedValue('registry said no');

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // a strange failure still costs one request
  });

  it('never rethrows a transport that throws synchronously', async () => {
    const fetchImpl: RegistryFetch = () => {
      throw new Error('transport exploded before the request');
    };

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
  });
});

describe('Step 66: the deadline is a hard bound on the whole operation', () => {
  it('abandons a request that rejects when the deadline aborts', async () => {
    const controller = new AbortController();
    const started = fetchLatestDepVitalsVersion({
      fetchImpl: hangingFetch(true),
      createAbortSignal: () => controller.signal,
    });

    await Promise.resolve();
    controller.abort();

    await expect(started).resolves.toBeNull();
  });

  it('abandons a request that ignores its signal entirely', async () => {
    const controller = new AbortController();
    const started = fetchLatestDepVitalsVersion({
      fetchImpl: hangingFetch(false),
      createAbortSignal: () => controller.signal,
    });

    await Promise.resolve();
    controller.abort();

    await expect(started).resolves.toBeNull();
  });

  it('never starts a request once the deadline has already elapsed', async () => {
    const { fetchImpl, calls } = recordingFetch(() => okBody('{"latest":"0.2.1"}'));

    await expect(
      fetchLatestDepVitalsVersion({ fetchImpl, createAbortSignal: () => abortedSignal() }),
    ).resolves.toBeNull();
    expect(calls).toEqual([]); // an expired bound costs no request at all
  });

  it('bounds a hanging request with the real built-in timeout signal', async () => {
    // The one case that uses real timers, still offline: a 1 ms bound plus a local hanging fake.
    await expect(
      fetchLatestDepVitalsVersion({ fetchImpl: hangingFetch(false), timeoutMs: 1 }),
    ).resolves.toBeNull();
  });

  it('reports no failure at all when the transport misbehaves', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    const { fetchImpl } = recordingFetch(() => rejecting(new Error('boom')));

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();

    stdout.mockRestore();
    stderr.mockRestore();
  });
});

describe('Step 66: untrusted or unexpected bodies are ignored', () => {
  it('returns null for an HTML body', async () => {
    const { fetchImpl } = recordingFetch(() =>
      okBody('<!DOCTYPE html><html><head><title>latest</title></head><body>0.2.1</body></html>'),
    );

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
  });

  it('returns null for an empty body and for truncated JSON', async () => {
    for (const text of ['', '{"latest":', '{', '{"latest":"0.2.1"', 'latest: 0.2.1']) {
      const { fetchImpl } = recordingFetch(() => okBody(text));

      await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
    }
  });

  it.each([
    ['an array root', '[{"latest":"0.2.1"}]'],
    ['a string root', '"0.2.1"'],
    ['a number root', '2'],
    ['a null root', 'null'],
    ['a boolean root', 'true'],
  ])('returns null for %s', async (_label, text) => {
    const { fetchImpl } = recordingFetch(() => okBody(text));

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
  });

  it.each([
    ['missing latest', {}],
    ['null latest', { latest: null }],
    ['numeric latest', { latest: 0.2 }],
    ['array latest', { latest: ['0.2.1'] }],
    ['object latest', { latest: { version: '0.2.1' } }],
    ['empty latest', { latest: '' }],
    ['whitespace latest', { latest: ' 0.2.1 ' }],
    ['v-prefixed latest', { latest: 'v0.2.1' }],
    ['two-component latest', { latest: '0.2' }],
    ['four-component latest', { latest: '1.2.3.4' }],
    ['prerelease latest', { latest: '0.2.0-rc.1' }],
    ['build-metadata latest', { latest: '1.2.3+build.5' }],
    ['leading-zero latest', { latest: '01.2.3' }],
    ['partial-token latest', { latest: '1.x.3' }],
    ['injected text latest', { latest: '0.2.1" onclick="evil()' }],
  ])('returns null for %s', async (_label, document) => {
    const { fetchImpl } = recordingFetch(() => okJson(document));

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
  });

  it('returns null when the body stream fails midway', async () => {
    const { response } = scriptedBody([ENCODER.encode('{"latest":"0.2')], {
      failure: new Error('body stream exploded'),
    });
    const { fetchImpl } = recordingFetch(() => Promise.resolve(response));

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
  });

  it('returns null for a body larger than the cap and releases the stream', async () => {
    const { response, wasCancelled } = scriptedBody([
      ENCODER.encode(paddedBody(MAX_UPDATE_RESPONSE_BYTES)),
      ENCODER.encode('trailing bytes that must never be accepted'),
    ]);
    const { fetchImpl } = recordingFetch(() => Promise.resolve(response));

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
    expect(wasCancelled()).toBe(true); // oversized answers are abandoned, not buffered forever
  });

  it('returns null when a stream overflows the cap inside a single chunk', async () => {
    const { fetchImpl } = recordingFetch(() => okBody(paddedBody(MAX_UPDATE_RESPONSE_BYTES + 1)));

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
  });

  it('survives a body whose release itself fails', async () => {
    const { response } = scriptedBody(
      [ENCODER.encode(paddedBody(MAX_UPDATE_RESPONSE_BYTES)), ENCODER.encode('overflow')],
      { cancelFailure: new Error('cancel failed') },
    );
    const { fetchImpl } = recordingFetch(() => Promise.resolve(response));

    await expect(fetchLatestDepVitalsVersion({ fetchImpl })).resolves.toBeNull();
  });
});

describe('Step 66: the lookup stays private to the notifier and offline for analysis', () => {
  const ANALYSIS_DIRECTORIES = ['core', 'scanner', 'detectors', 'reporters'];

  it('reads no credentials, environment or output and uses no ambient fetch', () => {
    for (const forbidden of [
      'process.env',
      'NPM_TOKEN',
      'npm_config',
      '_authToken',
      'Authorization',
      'console.',
      'process.stdout',
      'process.stderr',
      'globalThis.fetch',
      'require(',
      'http://',
    ]) {
      expect(MODULE_SOURCE).not.toContain(forbidden);
    }
  });

  it('requests https only and appends nothing to the endpoint', () => {
    expect(MODULE_SOURCE).toContain(`'${CONTRACT_ENDPOINT}'`);
    expect(MODULE_SOURCE).not.toContain('registry.npmjs.org/-/package/depvitals/dist-tags/');
  });

  it('is not reachable from any module of the offline analysis path', () => {
    const importers: string[] = [];

    for (const directory of ANALYSIS_DIRECTORIES) {
      for (const entry of readdirSync(join(SRC, directory), { recursive: true })) {
        const content = readFileSync(join(SRC, directory, String(entry)), 'utf8');

        if (content.includes('registryLookup')) {
          importers.push(`${directory}/${String(entry).split(/[\\/]/).join('/')}`);
        }
      }
    }

    expect(importers).toEqual([]);
  });
});
