/**
 * One bounded public lookup of the DepVitals `latest` dist-tag (Step 66).
 *
 * This is the **only** place in the whole product that may perform a network request, and the only
 * thing it can ever ask for is the public dist-tag metadata of the `depvitals` package itself.
 * Nothing about the analyzed project is used here: no project path, no manifest content, no
 * dependency name, no version, no user data and no credential of any kind. Core analysis stays
 * fully offline - this module lives under `src/cli/notifier/` and is never reachable from
 * `core/`, `scanner/`, `detectors/` or `reporters/` (asserted by tests), and it stays unwired until
 * the CLI integration step introduces the notifier orchestrator.
 *
 * Contract enforced by this module:
 *
 * 1. the URL is the fixed constant {@link NPM_DIST_TAGS_ENDPOINT}; nothing is appended to it and no
 *    caller-supplied string reaches it;
 * 2. the whole fetch + body + parse operation is bounded by a short timeout, and the bound cannot
 *    be loosened past {@link UPDATE_LOOKUP_MAX_TIMEOUT_MS}; when the bound elapses the request is
 *    abandoned (the abort signal tears the request down) and the result is `null`;
 * 3. a successful HTTP status is required, the body must stay at or below
 *    {@link MAX_UPDATE_RESPONSE_BYTES}, it must parse as a JSON object with an own `latest` string,
 *    and that string must be an exact stable version according to the single grammar owned by
 *    Step 63 (`versionCompare.parseStableVersion`);
 * 4. **every** failure mode - DNS, TLS, abort/timeout, non-2xx status, empty/oversized/malformed
 *    body, body stream error, invalid version - yields `null`. The function never throws and never
 *    logs, because an optional convenience must not be able to break or delay a scan;
 * 5. there are no retries: a failed lookup costs exactly one request and the caller falls back to
 *    "no notice", and the request carries no headers, so no npm token can leak to the registry.
 *
 * Testability: `fetch` and the abort-signal factory are injected, so the tests never touch the real
 * network, never depend on a real DNS/TLS stack and can simulate a hanging request deterministically.
 */

import { parseStableVersion } from './versionCompare.js';

/**
 * The fixed public endpoint of the update check, exactly as mandated by the update-notifier
 * contract. It is a constant so that no project-derived value can ever influence the request.
 */
export const NPM_DIST_TAGS_ENDPOINT = 'https://registry.npmjs.org/-/package/depvitals/dist-tags';

/**
 * Default hard bound for the complete request: one fetch plus its body and parse. Kept inside the
 * 300-500 ms window agreed for the notifier, so a slow or unreachable registry can only ever cost a
 * fraction of a second of an already finished scan.
 */
export const UPDATE_LOOKUP_TIMEOUT_MS = 400;

/**
 * Absolute ceiling for any injected timeout. Callers (and tests) may shorten the bound but cannot
 * turn the "short hard timeout" of the contract into an unbounded wait.
 */
export const UPDATE_LOOKUP_MAX_TIMEOUT_MS = 500;

/**
 * Largest response body that is accepted. The real dist-tag document is a few dozen bytes, so the
 * cap only ever rejects something hostile or unexpected; it is enforced while streaming, not after
 * buffering an arbitrarily large payload.
 */
export const MAX_UPDATE_RESPONSE_BYTES = 8 * 1024;

/**
 * The single stream method this lookup needs from a response body, i.e. a byte stream that can be
 * read incrementally and released early.
 */
export type RegistryStreamReader = {
  read(): Promise<{ done: boolean; value: Uint8Array | undefined }>;
  cancel(reason?: unknown): Promise<void>;
};

/** Response body shape: readable as a byte stream, or absent (`null`, e.g. for a 204). */
export type RegistryResponseBody = {
  getReader(): RegistryStreamReader;
};

/** The only response property this lookup consults: the HTTP status plus an optional body. */
export type RegistryResponse = {
  readonly status: number;
  readonly body: RegistryResponseBody | null;
};

/** The only request property this lookup sends: the timeout/abort signal. Never headers or bodies. */
export type RegistryRequestInit = {
  readonly signal: AbortSignal;
};

/**
 * The injected `fetch` implementation. It is required rather than defaulted so that no accidental
 * call inside this repository can reach the network: production callers pass the Node built-in
 * `fetch`, tests pass a stub returning canned responses and canned failures.
 */
export type RegistryFetch = (
  endpoint: string,
  init: RegistryRequestInit,
) => Promise<RegistryResponse>;

/** Dependencies of one lookup. Every field is injected, so nothing ambient is read implicitly. */
export type RegistryLookupOptions = {
  /** Transport to use, e.g. the Node built-in `fetch` bound by the caller. */
  readonly fetchImpl: RegistryFetch;
  /**
   * Optional shorter bound in milliseconds, clamped into `[0, UPDATE_LOOKUP_MAX_TIMEOUT_MS]`.
   * Defaults to {@link UPDATE_LOOKUP_TIMEOUT_MS}.
   */
  readonly timeoutMs?: number;
  /**
   * Abort-signal factory, defaulting to `AbortSignal.timeout`. Tests inject a factory returning a
   * controller signal (or an already-aborted signal) to exercise the timeout path without waiting.
   */
  readonly createAbortSignal?: (timeoutMs: number) => AbortSignal;
};

/** The Node built-in timeout signal, wrapped so the default never depends on `this`. */
function defaultCreateAbortSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

/**
 * Clamp an injected timeout into the contract's hard bound. Non-finite values (NaN, Infinity) fall
 * back to the default instead of disabling the bound.
 */
function boundTimeout(value: number): number {
  if (!Number.isFinite(value)) {
    return UPDATE_LOOKUP_TIMEOUT_MS;
  }

  if (value < 0) {
    return 0;
  }

  return Math.min(value, UPDATE_LOOKUP_MAX_TIMEOUT_MS);
}

/**
 * Run `operation` under an abort deadline. The first caller to settle wins: a request that ignores
 * its signal can still not extend the scan, because the deadline resolution is produced here instead
 * of relying on the transport to reject.
 *
 * @returns whatever `operation` resolved with, or `null` when the deadline aborted first.
 */
async function withAbortDeadline<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T | null> {
  if (signal.aborted) {
    // The deadline is already gone: do not start a request that cannot be answered in time.
    return null;
  }

  let onAbort: (() => void) | undefined;

  const deadline = new Promise<null>((resolve) => {
    onAbort = () => {
      resolve(null);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  const request = operation();

  try {
    // `Promise.race` attaches handlers to both promises, so a request that fails after the deadline
    // won the race cannot surface an unhandled rejection either.
    return await Promise.race([request, deadline]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Read a response body incrementally, accepting at most {@link MAX_UPDATE_RESPONSE_BYTES} in total.
 *
 * Bytes are concatenated before decoding, so a valid body split into chunks at any boundary (even
 * inside a multi-byte UTF-8 character) decodes correctly, and an oversized body is abandoned as soon
 * as the cap is crossed instead of being buffered.
 *
 * @returns the decoded text, or `null` when the body exceeded the cap.
 */
async function readCappedText(reader: RegistryStreamReader): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (value === undefined) {
      continue;
    }

    totalBytes += value.byteLength;

    if (totalBytes > MAX_UPDATE_RESPONSE_BYTES) {
      // Release the stream; a failing `cancel` is irrelevant because the answer is already `null`.
      await reader.cancel().catch(() => undefined);
      return null;
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Extract the `latest` dist-tag from the response text.
 *
 * Only a JSON object with an own `latest` **string** that is an exact stable DepVitals version is
 * accepted. HTML, truncated JSON, a non-object root, a missing or wrongly-typed `latest`, and a
 * prerelease/build-tagged/malformed version all mean "no answer".
 */
function extractLatestVersion(text: string): string | null {
  let document: unknown;

  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return null;
  }

  if (!Object.hasOwn(document, 'latest')) {
    return null;
  }

  const latest = (document as Record<string, unknown>)['latest'];

  if (typeof latest !== 'string') {
    return null;
  }

  // One grammar for "exact stable version", owned by Step 63; prerelease and malformed never pass.
  return parseStableVersion(latest) === undefined ? null : latest;
}

/**
 * Perform one bounded read of the dist-tag document and return the validated `latest` version.
 *
 * @throws whatever the transport or the body stream throws; the public wrapper converts every
 *   failure into `null`.
 */
async function requestLatest(
  fetchImpl: RegistryFetch,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetchImpl(NPM_DIST_TAGS_ENDPOINT, { signal });

  // A redirect, 4xx or 5xx answer is not metadata; the body is not even read.
  if (response.status < 200 || response.status >= 300) {
    return null;
  }

  if (response.body === null) {
    return null;
  }

  const text = await readCappedText(response.body.getReader());

  if (text === null) {
    return null;
  }

  return extractLatestVersion(text);
}

/**
 * Fetch the public `latest` dist-tag of the **DepVitals package itself**, at most once.
 *
 * The call is fully isolated: it never throws, never retries, never writes to stdout or stderr and
 * never sends project-derived data or credentials. Any problem - DNS failure, TLS failure, abort or
 * timeout, HTTP error status, empty, oversized, HTML or malformed body, missing `latest`, body
 * stream error - results in `null`, which the caller must treat as "no update information".
 *
 * @param options - Injected transport and (optionally) a shorter timeout plus abort-signal factory.
 * @returns the validated stable version string, or `null` for every other outcome.
 */
export async function fetchLatestDepVitalsVersion(
  options: RegistryLookupOptions,
): Promise<string | null> {
  try {
    const createAbortSignal = options.createAbortSignal ?? defaultCreateAbortSignal;
    const timeoutMs = boundTimeout(options.timeoutMs ?? UPDATE_LOOKUP_TIMEOUT_MS);
    const signal = createAbortSignal(timeoutMs);

    return await withAbortDeadline(signal, () => requestLatest(options.fetchImpl, signal));
  } catch {
    // No error detail is reported anywhere: an optional network convenience stays silent.
    return null;
  }
}
