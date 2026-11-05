# External project corpus — acquisition and baseline observations

This catalog identifies four public upstream snapshots acquired on November 4, 2026. It is separate
from the synthetic measurement corpus. No upstream source is redistributed here. The catalog includes
licenses, immutable commits, archive hashes, full snapshot inventories, selected roots and scope.
**Expected findings are NOT REVIEWED.** Acquisition and raw CLI observations do not establish accuracy,
compatibility with an entire framework, or that a dependency can safely be removed.

| ID                      | Upstream                                                                                | Selected root | Source files | Selection rationale                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------- | ------------- | -----------: | -------------------------------------------------------------------------------------------------------------- |
| is-number               | [jonschlinkert/is-number](https://github.com/jonschlinkert/is-number)                   | `.`           |            4 | Small CommonJS Node library, Mocha, ESLint JSON and benchmark tooling.                                         |
| p-limit                 | [sindresorhus/p-limit](https://github.com/sindresorhus/p-limit)                         | `.`           |            6 | ESM library, runtime dependency, AVA tests and TypeScript declarations/tsd.                                    |
| ts-extras               | [sindresorhus/ts-extras](https://github.com/sindresorhus/ts-extras)                     | `.`           |           71 | TypeScript source/tests, type-only imports, inherited tsconfig and Node/tsx tooling.                           |
| preact-render-to-string | [preactjs/preact-render-to-string](https://github.com/preactjs/preact-render-to-string) | `.`           |           56 | Demanding JSX/testing case with Preact peer/dev overlap, declarations, build scripts and static configuration. |

Each is evaluated as one root package inventory, without workspace aggregation. Selection preceded
scanning; projects were not chosen for a clean result. The unavailable `preactjs/preact-markup`
candidate and acquisition failure are recorded in [manifest.json](manifest.json). No authentication was
attempted. The four acquired manifests have no root `workspaces` declaration. This does not imply
support for every feature in them: aliases, arbitrary tool configuration, external tsconfig inheritance,
ambient types and wrapper arguments need independent review under the supported evidence rules.

## Reacquire an exact snapshot

Acquisition alone needs network access. Use a task-owned directory outside this tracked fixture
folder. Choose a catalog entry, copy its exact `upstream`, full `commit` and `archiveSha256`, and fetch
that commit. Do not substitute a current branch head. For example, with trusted values from the catalog:

```sh
corpus_dir="$(mktemp -d /tmp/depvitals-corpus.XXXXXX)"
project_id=is-number
upstream=https://github.com/jonschlinkert/is-number
commit=98e8ff1da1a89f93d1397a24d7413ed15421c139
export GIT_TERMINAL_PROMPT=0
export GIT_LFS_SKIP_SMUDGE=1
git -c core.hooksPath=/dev/null init --bare --template= "$corpus_dir/$project_id.git"
git -c credential.helper= -c core.hooksPath=/dev/null \
  --git-dir="$corpus_dir/$project_id.git" fetch --depth=1 "$upstream.git" "$commit"
test "$(git --git-dir="$corpus_dir/$project_id.git" rev-parse FETCH_HEAD)" = "$commit"
git --git-dir="$corpus_dir/$project_id.git" archive --format=tar "$commit" \
  > "$corpus_dir/$project_id.tar"
sha256sum "$corpus_dir/$project_id.tar"
```

Check that hash against the catalog **before** extraction. Extract only into a new dedicated directory,
using safe data-only extraction that rejects absolute/traversing paths, devices and escaping links
(for example Python `tarfile.extractall(..., filter='data')`). The acquisition used Git bare shallow
clones and `git archive`; there was no checkout, dependency install, submodule recursion or execution
of source, configuration, hooks or lifecycle scripts. The selected archive tree preserves upstream
file bytes and relative paths. Git archive/export attributes define the snapshot; the archive and
recursive inventory both participate in provenance. License files are hashed in the catalog.

Keep the original source export and evaluate that export directly or an identical task-owned copy.
All four initial entries use upstream default scope, with no DepVitals configuration or evaluation
overlays. Fixed discovery exclusions are recorded separately. Do not add exceptions to make a scan
pass; any future overlay requires a separate identified staged scope and original/default observation.

## Offline evaluator

The [development evaluator](../../../scripts/evaluate-corpus.mjs) accepts only explicit acquired roots
and an already built CLI. It never downloads, installs, builds, imports target code or invokes package
scripts. Once source is acquired, evaluation uses no network. The normal CLI runs with `CI=1` and
`DEPVITALS_NO_UPDATE_CHECK=1`; injected Node preload options are removed.

Create an untracked root-map JSON with exactly the four catalog IDs and **absolute repository-export
paths**, without `.git` or `node_modules`. `selectedRoot` is resolved beneath each mapped export. A
missing, moved, changed or substituted tree fails preflight instead of being fetched. Identical copies
may be relocated by explicitly updating the map; identity is based on contents, not machine paths.

```json
{
  "is-number": "/tmp/depvitals-corpus/is-number",
  "p-limit": "/tmp/depvitals-corpus/p-limit",
  "ts-extras": "/tmp/depvitals-corpus/ts-extras",
  "preact-render-to-string": "/tmp/depvitals-corpus/preact-render-to-string"
}
```

From the DepVitals checkout, build with the repository's exact locked pnpm. Record the reviewed full
source SHA, confirm product source/package/lock/workspace equivalence to the intended baseline, and
create a tool descriptor from the current source and complete emitted build. `identifyTool` records
bytes and a caller-reviewed SHA; it does not prove that a build was generated from that source. A
successful version probe alone is insufficient. For example, after the applicable build/checks:

```sh
pnpm run build
git rev-parse HEAD
```

With that inspected SHA supplied explicitly, this development-only Node snippet writes the descriptor
outside the scanned roots (replace the placeholder with the reviewed 40-character SHA):

```js
import { writeFileSync } from 'node:fs';
import { identifyTool } from './scripts/evaluate-corpus.mjs';
const identity = identifyTool(process.cwd(), '<reviewed-full-source-sha>');
writeFileSync('/tmp/depvitals-tool-identity.json', JSON.stringify(identity, null, 2) + '\n');
```

Then invoke the evaluator. The output parent must already exist; the output must be new and outside
all mapped exports and the tool's source/build. Evaluation never replaces an existing receipt:

```sh
node scripts/evaluate-corpus.mjs \
  --manifest test/fixtures/external-corpus/manifest.json \
  --roots /tmp/depvitals-corpus-roots.json \
  --tool-root "$PWD" \
  --tool-identity /tmp/depvitals-tool-identity.json \
  --output /tmp/depvitals-baseline-observations.json
```

The evaluator verifies the entire corpus before running any subprocess. It captures status, signal,
stdout and stderr through the ordinary built CLI, checks all target inputs and tool bytes before/after,
and retains operational errors as observations. A completed findings scan (exit 1) or operational
error (exit 1, empty stdout) can produce a valid observation receipt. The evaluator itself exits 0
when collection succeeds; that does **not** mean the projects are clean. Timeout, signal, unexpected
exit, identity mismatch or malformed output channels fail collection and do not produce a success
receipt. Each scan is bounded at 30 seconds and 16 MiB of captured output.

On macOS, the system aliases `/tmp` and `/var` are accepted through their `/private` spellings.
Project-created root/ancestor symlinks remain rejected. Output containment compares canonical
directories, including when the input map and receipt use different system-alias spellings.

Snapshot hashes cover sorted recursive directory names, regular file bytes/executable bits and
symlink target text. Links are not followed; special files are rejected. This is a conservative superset
of scan inputs, including detector barrier names and nested manifests. Catalog hash means SHA-256 of
`JSON.stringify(parsedCatalog)`; snapshot hash means SHA-256 of `JSON.stringify(entries)`. Whitespace
formatting of the catalog alone does not change semantic identity. Archive SHA-256 binds acquisition
bytes independently. These checks detect observed before/after changes; they are not a concurrent
filesystem snapshot or security guarantee.

Do not check in local maps, descriptors, raw receipts, archives, upstream sources or machine-specific
paths. Store them in task-owned locations. Prefer neutral temporary roots when retaining literal
operational diagnostics so local usernames do not enter receipts. The checked-in catalog contains no
machine paths. Routine tests use authored temporary fixtures and never fetch upstream projects.

## Next review

Independent current-contract expectations and project-use assessments are subsequent work. Preserve
raw output separately; do not derive expected arrays by copying the observed report. Review uncertainty,
unsupported patterns, intentional exceptions and confirmed bugs separately before selecting corrections.
No numerical accuracy or performance claim follows from this initial corpus. The synthetic corpus and
its regressions remain maintained. Future JSON/query observations extend this same evaluator after
those CLI interfaces exist.
