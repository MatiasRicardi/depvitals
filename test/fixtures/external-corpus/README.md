# External project corpus — acquisition and baseline observations

This catalog identifies four public upstream snapshots acquired on November 4, 2026. It is separate
from the synthetic measurement corpus. No upstream source is redistributed here. The catalog includes
licenses, immutable commits, archive hashes, full snapshot inventories, selected roots and scope.
**Acquisition alone does not review findings.** The separately bound baseline sidecar records the
subsequent REVIEWED source/manifest assessment. Raw CLI observations alone do not establish accuracy,
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

Build the exact `v0.3.0` tag in a separate checkout with its locked toolchain. Confirm the clean
checkout and the full source SHA `f9302f19ae48498487c8801be199e13da3d15990` before building.
Run the following commands from the **current evaluator checkout**, setting `baseline_root` to the
absolute path of the separate build. The current evaluator's `identifyTool` reads the baseline's
source, build and metadata. Its SHA argument identifies the source you verified before building.

```sh
baseline_root=/absolute/path/to/depvitals-v0.3.0
node --input-type=module - "$baseline_root" <<'JS'
import { writeFileSync } from 'node:fs';
import { identifyTool } from './scripts/evaluate-corpus.mjs';

const identity = identifyTool(process.argv[2], 'f9302f19ae48498487c8801be199e13da3d15990');
writeFileSync('/tmp/depvitals-baseline-tool.json', JSON.stringify(identity, null, 2) + '\n');
JS

node scripts/evaluate-corpus.mjs \
  --manifest test/fixtures/external-corpus/manifest.json \
  --roots /tmp/depvitals-corpus-roots.json \
  --tool-root "$baseline_root" \
  --tool-identity /tmp/depvitals-baseline-tool.json \
  --output /tmp/depvitals-baseline-observations.json
```

Use an existing output parent outside all mapped exports and the tool's source/build directories.
Evaluation requires a new output path and preserves existing receipts.

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

## Baseline review sidecar

The [baseline review](baseline-review.json) and [project matrix](../../../docs/compatibility/v0.4.0.md)
record source/manifest judgments separately from raw observations. The acquisition catalog retains
its original `NOT REVIEWED` state. Review completion belongs to the sidecar; a `DRAFT` sidecar remains
incomplete even when its primary expectations match the scanner.

After the independent review has actually completed, add
`--reviewed-baseline test/fixtures/external-corpus/baseline-review.json` to the evaluator invocation.
The comparator requires `REVIEWED`, distinct recorded reviewers, the same semantic catalog and source
identity, exact expected process channels and independently specified finding arrays. A draft,
changed identity or disagreement fails without writing a success receipt. Raw collection without
this option remains available and does not certify expectations. The development-only terminal
reader is for the frozen v0.3 baseline format; it is not a production CLI parser or detection engine.

## Reviewed target and local cost

Use the same four pinned exports and root map for both builds. The target comparison uses the
[reviewed baseline](baseline-review.json) and the separate [target expectations](target-expectations.json)
that bind it by SHA-256. They allow only the two selected F1 removals and pin specific source and
script evidence plus a negative config sample. The evaluator checks terminal and JSON findings,
effective scope, package-local counts and exact sampled provenance. Each query must agree with its
record in the full JSON scan. The baseline remains a separate terminal-only evaluation.

Use two clean builds. For the baseline, build the source from the exact `v0.3.0` tag
(`f9302f19ae48498487c8801be199e13da3d15990`) with its locked toolchain. For the target, build the
source commit recorded in the [comparison](../../../docs/compatibility/v0.4.0.md#step-121-rerun).
Verify source, metadata and build identities for both. Use the evaluator from the current checkout
for both runs. After each clean build, produce an adjacent tarball and metadata without triggering
another build or contacting the registry:

```sh
# Run in each build's root. Set pack_dir to a new absolute output directory.
mkdir -p "$pack_dir"
npm pack --offline --ignore-scripts --json --pack-destination "$pack_dir" > "$pack_dir/pack.json"
```

Using the arguments from the baseline recipe, add `--pack "$pack_dir/pack.json"` to the verified
baseline invocation. For the target, replace the tool root, identity, pack and output with the
target equivalents, and add `--reviewed-target test/fixtures/external-corpus/target-expectations.json`.
Keep `--reviewed-baseline test/fixtures/external-corpus/baseline-review.json` for both. Without
`--pack`, the evaluator collects results without cost samples.

The measured invocations run the built CLI with a private pipe for RSS at process exit. Each
terminal or JSON scan gets one uninstrumented reference, two warmups and five recorded samples.
Warmups and samples must match the reference bytes and channels. Reported wall time includes
startup, analysis, rendering and output capture. The byte count at exit is whole-process RSS.
Query checks, identity hashing and archive validation are outside the timed intervals.
The archive verifier binds every packaged byte to the measured build or checkout metadata.
Keep the raw receipts and archives locally. This recipe does not install or execute target
project code.
