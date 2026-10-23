/**
 * The single optional update-check orchestrator (Step 67).
 *
 * This module is the only place where the private notifier helpers of Steps 63-66 are combined, and
 * the only place that decides whether a *newer DepVitals version* notice exists for one invocation.
 * The fixed order is the one mandated by the update-notifier contract:
 *
 * 1. eligibility (`isEligibleUpdateCheck`): an ineligible invocation stops here, before any cache
 *    read and before any network attempt, so an opt-out, a CI run or a piped stream costs nothing;
 * 2. a fresh cache read (`readCachedLatest`);
 * 3. at most one bounded public lookup on a cache miss (`fetchLatestDepVitalsVersion`);
 * 4. an optional cache write of the validated result;
 * 5. a strict stable-version comparison against the installed CLI version;
 * 6. the notice text, returned to the caller as data.
 *
 * Design rules:
 *
 * - **No output.** The orchestrator never writes to stdout/stderr and never imports a stream. It
 *   returns notice text; the CLI entry point owns the channels and the ordering, which is what keeps
 *   the deterministic report on stdout byte for byte.
 * - **No project data.** Nothing about the analyzed project (path, manifest, dependency names) is
 *   accepted or forwarded here. The inputs are the completed command kind, the installed package
 *   version, the environment map and the two interactivity flags.
 * - **Silent by construction.** Every failure path - cache error, transport error, malformed
 *   response, timeout, unusable clock, non-stable version - resolves to `undefined`, and the whole
 *   pipeline additionally runs inside a `try`/`catch` and inside an explicit wall-clock budget, so a
 *   misbehaving cache or registry can never change an exit code and can never delay the process
 *   beyond that budget.
 * - **Fully injected.** Clock, cache directory and transport are injectable, which is what lets the
 *   CLI tests stay deterministic and offline. With no seams injected the production defaults are the
 *   user cache directory and the built-in `fetch`; no test ever reaches the public registry.
 */

import {
  isEligibleUpdateCheck,
  type NotifierCommandKind,
  type NotifierEnv,
} from './eligibility.js';
import {
  fetchLatestDepVitalsVersion,
  type RegistryFetch,
  type RegistryResponse,
} from './registryLookup.js';
import { readCachedLatest, writeCachedLatest, type UpdateCacheOptions } from './updateCache.js';
import { isNewerStableVersion } from './versionCompare.js';

/**
 * The wall-clock budget for the whole optional check (cache read, at most one lookup, cache write).
 *
 * The lookup already carries its own hard bound, so this outer budget only exists to make "the
 * process never waits on an unbounded promise" explicit and verifiable: when it elapses the check
 * resolves to "no notice", whatever the transport is still doing.
 */
export const UPDATE_CHECK_BUDGET_MS = 1000;

/** What the check needs to decide, all of it passed in by the CLI entry point. */
export type UpdateNoticeRequest = {
  /** Which command the CLI completed. Only a completed scan can produce a notice. */
  readonly commandKind: NotifierCommandKind;
  /** The installed DepVitals package version, i.e. the version `package.json` declares. */
  readonly currentVersion: string;
  /** The environment map used for the eligibility gates. */
  readonly env: NotifierEnv;
  /** Whether standard output is an interactive terminal. */
  readonly stdoutTTY: boolean;
  /** Whether standard error is an interactive terminal. */
  readonly stderrTTY: boolean;
};

/**
 * Test-only seams. They exist so the CLI tests can pin a clock, a temporary cache directory and a
 * stub transport instead of the real cache location and the real network; production passes none.
 */
export type UpdateNoticeSeams = {
  /** Cache directory override; only an absolute path is honored (see `updateCache`). */
  readonly cacheDir?: string;
  /** Transport override; defaults to the built-in `fetch`. */
  readonly fetchImpl?: RegistryFetch;
  /** Clock override, in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Budget override, in milliseconds; defaults to {@link UPDATE_CHECK_BUDGET_MS}. */
  readonly budgetMs?: number;
};

/** The notifier collaborator the entry point uses; `collectUpdateNotice` is the production default. */
export type UpdateNoticeCollector = (request: UpdateNoticeRequest) => Promise<string | undefined>;

/**
 * The production transport: the built-in `fetch`, narrowed to the shape the registry lookup accepts.
 *
 * Only the endpoint and the abort signal are forwarded - never a header, a body, a credential or any
 * project-derived value - because `RegistryRequestInit` has exactly one field.
 */
async function builtInFetch(
  endpoint: string,
  init: { signal: AbortSignal },
): Promise<RegistryResponse> {
  const response = await fetch(endpoint, { signal: init.signal });

  return { status: response.status, body: response.body };
}

/**
 * The notice text: two lines, no colour, no emoji, no ANSI, and no claim about how DepVitals was
 * installed. `npx depvitals@latest` is offered as a way to run the published release, not as an
 * instruction to install anything.
 */
export function formatUpdateNotice(currentVersion: string, latestVersion: string): string {
  return (
    `\nNew DepVitals version available: ${currentVersion} -> ${latestVersion}\n` +
    'Run: npx depvitals@latest\n'
  );
}

/**
 * Resolve the `latest` version to compare against, using the cache first.
 *
 * Returns `undefined` when nothing usable is known: a fresh cache hit yields the cached string and
 * no request at all; otherwise exactly one bounded lookup happens, and its validated result is
 * remembered for the next run. A failed lookup yields `undefined` and caches nothing.
 */
async function resolveLatestVersion(
  request: UpdateNoticeRequest,
  seams: UpdateNoticeSeams,
): Promise<string | undefined> {
  const cacheOptions: UpdateCacheOptions = {
    env: request.env,
    now: seams.now?.() ?? Date.now(),
    ...(seams.cacheDir === undefined ? {} : { cacheDir: seams.cacheDir }),
  };

  const cached = await readCachedLatest(cacheOptions);

  if (cached !== undefined) {
    return cached;
  }

  const fetched = await fetchLatestDepVitalsVersion({
    fetchImpl: seams.fetchImpl ?? builtInFetch,
  });

  if (fetched === null) {
    return undefined;
  }

  // Best effort and silent: a cache that cannot be written costs the next run one extra lookup.
  await writeCachedLatest(fetched, cacheOptions);

  return fetched;
}

/**
 * Run the whole optional check inside a fixed wall-clock budget.
 *
 * The deadline resolves with the "no notice" value instead of throwing, and it stays **referenced**
 * for exactly as long as the `await` below is pending. That ownership is the point of this helper:
 * the CLI entry point derives its exit status from an awaited call, so if nothing held the event
 * loop open while the notifier was in flight, Node could reach an idle loop with that await still
 * pending and terminate on the unsettled top-level await path - replacing the scan's own `0`/`1`
 * status with exit `13` and a warning. Neither the transport (which may never answer) nor the
 * lookup's `AbortSignal.timeout` (whose timer does not hold the loop open) can make that guarantee,
 * so this timer does.
 *
 * It is bounded and short-lived, never a keepalive: the `finally` clears it on every path, so a
 * cache hit or a fast lookup leaves nothing pending and the process exits immediately. A stalled
 * transport costs at most this budget, and in practice only the lookup's own shorter timeout,
 * because a live event loop is what lets that timeout fire at all.
 *
 * A rejection of the work (which the notifier helpers themselves never produce) propagates to the
 * caller's `catch`, which is also silent.
 */
async function withinBudget(
  work: () => Promise<string | undefined>,
  budgetMs: number,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, budgetMs);
  });

  const task = work();

  // If the deadline wins, a later failure of the work must not become an unhandled rejection in a
  // short-lived CLI process; the answer is already "no notice".
  task.catch(() => undefined);

  try {
    return await Promise.race([task, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Decide whether this invocation has a newer-version notice, and produce its text.
 *
 * @param request - The completed command kind, the installed version, the environment and the two
 *   interactivity flags. Nothing project-derived is accepted.
 * @param seams - Test-only clock/cache/transport overrides.
 * @returns The notice text, or `undefined` for every silent case: ineligible invocation, no usable
 *   version information, a failed or timed-out lookup, and a `latest` that is not strictly newer.
 */
export async function collectUpdateNotice(
  request: UpdateNoticeRequest,
  seams: UpdateNoticeSeams = {},
): Promise<string | undefined> {
  try {
    // Gate first: an ineligible run must not read the cache, must not touch the network and must not
    // print anything, so every `await` below sits behind this single predicate.
    if (
      !isEligibleUpdateCheck({
        env: request.env,
        stdoutTTY: request.stdoutTTY,
        stderrTTY: request.stderrTTY,
        commandKind: request.commandKind,
      })
    ) {
      return undefined;
    }

    const latest = await withinBudget(
      () => resolveLatestVersion(request, seams),
      seams.budgetMs ?? UPDATE_CHECK_BUDGET_MS,
    );

    if (latest === undefined) {
      return undefined;
    }

    if (!isNewerStableVersion(request.currentVersion, latest)) {
      return undefined;
    }

    return formatUpdateNotice(request.currentVersion, latest);
  } catch {
    // The optional notification is never an error source: no message, no exit-code change, no retry.
    return undefined;
  }
}
