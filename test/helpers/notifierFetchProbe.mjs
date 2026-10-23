/**
 * Observes and controls the optional update check of the **built** CLI.
 *
 * Loaded with `node --import` before `dist/cli/index.js`, so it runs before the CLI module is
 * imported. It only does what a test cannot express from the outside:
 *
 * - `DEPVITALS_TEST_REQUEST_FILE` - replaces the global `fetch` with a recording transport. Every
 *   request is appended to that file as its endpoint. When `DEPVITALS_TEST_RESPONSE_LATEST` is also
 *   set, the recorder answers with a canned dist-tag document; otherwise it fails loudly instead of
 *   resolving. Either way no real network access happens in a test.
 * - `DEPVITALS_TEST_FORCE_TTY=1` - reports both output streams as interactive, so a spawned child can
 *   be eligibility-positive while its output is still captured over a pipe. Without it the child stays
 *   non-interactive, which is the piped-CLI case itself.
 * - `DEPVITALS_TEST_STALL` - makes the recorded transport hang forever, which is how a registry that
 *   accepts a connection and never answers is simulated without a socket, a server or a timer:
 *   - `fetch` - the request promise never settles;
 *   - `body` - the request resolves with a `200`, and reading the body never settles.
 *   A stalled transport deliberately installs **no** keepalive of its own: the child must terminate
 *   on the notifier's own deadline, so any regression surfaces as a hanging or exit-13 process.
 *
 * Nothing here decides product behaviour, and nothing outside the notifier is replaced. These flags
 * belong to the test harness alone: no file under `src/` reads a `DEPVITALS_TEST_*` variable.
 */

const { appendFileSync } = await import('node:fs');

const requestFile = process.env['DEPVITALS_TEST_REQUEST_FILE'];
const cannedLatest = process.env['DEPVITALS_TEST_RESPONSE_LATEST'];
const stallMode = process.env['DEPVITALS_TEST_STALL'];

/** A promise that never settles, i.e. a transport that accepts the call and never answers. */
function neverSettles() {
  return new Promise(() => {});
}

/**
 * A response whose body reader never answers, shaped like the two fields the notifier reads from a
 * response (`status` and a `body` exposing `getReader`).
 */
function stalledBodyResponse() {
  return {
    status: 200,
    body: {
      getReader: () => ({
        read: () => neverSettles(),
        cancel: async () => undefined,
      }),
    },
  };
}

if (process.env['DEPVITALS_TEST_FORCE_TTY'] === '1') {
  process.stdout.isTTY = true;
  process.stderr.isTTY = true;
}

if (requestFile !== undefined && requestFile !== '') {
  globalThis.fetch = async (input) => {
    const endpoint = typeof input === 'string' ? input : String(input);

    appendFileSync(requestFile, `${endpoint}\n`, 'utf8');

    if (stallMode === 'fetch') {
      return neverSettles();
    }

    if (stallMode === 'body') {
      return stalledBodyResponse();
    }

    if (cannedLatest === undefined || cannedLatest === '') {
      throw new TypeError(`update notifier reached the network in a test: ${endpoint}`);
    }

    // Shape-compatible with the response the notifier reads: a status and a JSON dist-tag body.
    return new Response(JSON.stringify({ latest: cannedLatest }), { status: 200 });
  };
}
