# Local scanning and artifact observations — Step 94

Recorded November 2, 2026 (America/Montevideo). This is development evidence for the planned v0.3.0;
package metadata still says **0.2.0**. Nothing was published or installed for this measurement.

[Raw receipt](step94.json), [historical observations](step94-historical.json),
[measurement helper](../../scripts/measure-scanning.mjs),
[identity verifier](../../scripts/measurementIdentity.mjs), and
[fixed corpus/independent expectations](../../test/fixtures/measurement-corpus/corpus.json).
All new fixture code is authored for this repository under its license; no external project was
downloaded or redistributed. The three small synthetic projects represent syntax/evidence channels,
not real application complexity. DepVitals itself is the one actual repository in this corpus.

## Identity and method

Base source HEAD: `a3096adb34585cf940040357ae73b465e2fb47d4`. The review corrections are working-tree
changes. Production source, package metadata, lockfile and package verification remain untouched.
The receipt hashes both development helpers, the corpus manifest, lockfile, emitted build and retained
source/metadata inputs. Sorted root entry names also participate in input identity: this conservative
superset captures detector barriers without duplicating their allowlists. Opaque entries are recorded
by name without reading their contents; regular legacy JSON is hashed under its actual casing.
Names and bytes are checked again after each project scan.

Environment: linux x64, kernel `7.3.0-4-cachyos`, Node `v26.6.0`,
`Intel(R) Core(TM) i7-10510U CPU @ 1.80GHz`, 8 logical CPUs, pnpm 11.28.3 and npm 11.18.0. Shared local machine;
CPU scheduling, filesystem caches and runtime GC affect observations. No native macOS/Windows,
minimum-runtime or exact-commit CI result is claimed.

Each row has three warmups and seven measured runs in one process, after a clean build. Timed scans
collect the existing static ESLint/Jest hints and call `analyzeProject` with validated fixed scope.
Process startup, config-file loading, report rendering, setup, expected-finding comparisons and
explicit GC are outside the interval. The scan wrapper includes its constant root-identity sanity
check, as stated in the raw receipt. This is an internal analysis measurement, not end-to-end CLI latency. Every warmup and
sample must equal the independent finding arrays; unexpected results abort the receipt.

Explicit GC runs before and after samples. Memory fields are whole-process boundary observations:
net heap changes can be negative if automatic GC ran inside a scan. They are neither allocation totals
nor in-scan peaks, and the process is reused between cases. The table shows the largest observed net
heap increase, not a per-project memory budget. Raw samples include absolute heaps and RSS. The entire
harness's cumulative maxRSS, including archive validation/setup/generated trees, was 226.094 MiB.

## Fixed corpus

| Input              | Source files | Source bytes | Scope rules | Median ms | Largest net heap increase, MiB |
| ------------------ | -----------: | -----------: | ----------: | --------: | -----------------------------: |
| node-esm           |            2 |          245 |           0 |     4.006 |                          0.665 |
| typescript-tooling |            3 |          244 |           0 |     3.981 |                          0.343 |
| jsx-tsx            |            2 |          327 |           0 |     3.500 |                          0.274 |
| depvitals-self     |          100 |    1,444,872 |           2 |   480.226 |                         21.650 |

Expected findings, checked on every scan:

- **Node/ESM:** `node-regex-decoy` unused production; `node-payload-decoy` unused dev;
  `node-missing` missing. Static import, dynamic options and CommonJS division each use a distinct
  live package name; regex and here-document payloads remain inert, exterior `prettier` is credited.
- **TypeScript tooling:** `ts-shadow-decoy` unused production and `@types/node` unused dev;
  no missing. Type-only import, declaration import query and runtime call have unique live names.
  Parameter-owned require stays local. `tsc` and the Jest preset supply ordinary hints. Ambient
  Node types have no inferred usage; this result does not justify removing the types package.
- **JSX/TSX:** `jsx-text-decoy` unused production and `tsx-missing` missing; no unused dev.
  JSX component import, TSX component/type imports and an expression call each use distinct names;
  markup/attribute text supplies no evidence. No automatic JSX-runtime inference is claimed.
- **DepVitals:** no missing or unused production dependencies; `@types/node` and
  `@vitest/coverage-v8` unused dev. Node globals/builtin imports do not credit ambient types, and
  `coverage.provider: 'v8'` has no coverage-provider mapping. Both are known static-evidence limits,
  retained in the result rather than suppressed. TypeScript configuration is not resolved.

The self scan explicitly excludes `instructions` and `test/fixtures`, whose archived experiments and
synthetic/malformed projects are not application source. These are **two path scope decisions**, zero
dependency exceptions, not improved detection accuracy. The other three projects have no exclusions.
The helper passes these validated scopes internally; it does not create a root config or change any
project file. Fixture input identity is fixed by source hashes; timings do not execute imports,
components, scripts, lifecycle hooks, or resolve/install their named packages.

The self scan holds 101 validated inputs totalling 1,446,841 bytes: 100 supported sources plus
`package.json`. By area that is `test/` 70 files / 1,013,707 bytes, `src/` 24 files / 383,514 bytes,
`scripts/` 4 files / 45,185 bytes and three root files (`eslint.config.js` 1,949, `package.json` 1,969,
`vitest.config.ts` 517). The largest single source is `src/scanner/moduleSpecifiers.ts` at 162,645 bytes
(11.3% of scanned source bytes), and the two largest test files add 185,679 bytes. At the recorded median
that is 4.80 ms per supported source and 2.87 MiB/s. These rates use the source-only byte count
(1,444,872) and unrounded scan median (480.226473 ms); the input byte total also includes `package.json`.
Ignored `instructions/` and fixture contents are outside that inventory: this measures the selected
source scope, not every archived file.

## Growing import-property corpus and renamed control

Both forms are exactly `({PROPERTY:1});` repeated N times plus `require('real');`. Every sample must
extract only `real`. These rows time extraction only, separately from filesystem/project scanning.

| Entries | Current import ms | Current other ms | Historical Step86 import / other ms |
| ------- | ----------------: | ---------------: | ----------------------------------: |
| 500     |            10.126 |            9.542 |                      10.012 / 8.047 |
| 1,000   |            16.799 |           16.000 |                     14.732 / 16.171 |
| 2,000   |            31.476 |           31.891 |                     32.774 / 37.366 |
| 4,000   |            58.864 |           58.610 |                     62.811 / 52.935 |
| 8,000   |           111.631 |          111.659 |                        not measured |

The current growth rows retain both spellings as controls; the raw samples, rather than a strict
millisecond ratio, are the recorded evidence. At the shared sizes, the
historical and current observations are of a similar order and do not show the old disproportionate
import-property cost. No narrow timing assertion, universal complexity proof or speed guarantee is
made. Step86 used three measured runs; this helper uses seven. The historical JSON records Node/Linux
but not its exact measured source SHA or CPU, so this is context, not a controlled before/after claim.

The raw historical Step73 baseline includes a 4,000-import median of 2783.956 ms
versus the then-fixed median of 55.445 ms. That older corpus omitted the final require;
it is preserved as historical evidence, not rerun here or used for a percentage improvement claim.
No new workers, caches or optimization changes were needed for these observations.

## Large-tree pruning

Each generated file contains one unique undeclared `prune-tree-<five-digit-index>` require, with
100 files per directory. One retained file requires declared `prune-live`. Setup is outside timing;
temporary trees are removed after byte/metadata identity checks. The receipt records generator
parameters and aggregate input/result hashes, not thousands of repeated finding strings.

| Generated files | Selected sources unpruned / pruned | Unpruned median ms | Pruned median ms | Missing unpruned / pruned |
| --------------- | ---------------------------------: | -----------------: | ---------------: | ------------------------: |
| 0               |                              1 / 1 |              1.952 |            1.895 |                     0 / 0 |
| 1,000           |                          1,001 / 1 |            103.416 |            1.736 |                 1,000 / 0 |
| 5,000           |                          5,001 / 1 |            468.146 |            2.320 |                 5,000 / 0 |

With `generated` excluded, discovery returns only the retained file, so the large subtree contributes
neither source reads nor evidence. The maintained Step90/Step93 tests separately assert pre-descent
pruning/error behavior; timings alone cannot prove an I/O boundary. Removing 5,000 missing findings is
a deliberate reduction of scope, **not an accuracy gain**. There is no strict millisecond threshold.

## Local artifact cost

After `pnpm run clean` and `pnpm run build`, local `npm pack --ignore-scripts --json` reported
**160,851 packed bytes** (157.081 KiB), **684,243 unpacked bytes**
(668.206 KiB), and **99 files**. Actual tarball bytes and SHA-512 integrity were
checked against the pack metadata before deleting the temporary archive. The runner itself now reads
the adjacent archive and validates compressed size, SHA-1, SHA-512 SRI, unpacked sizes and the complete
file list. Every packaged `dist/` file must match the measured build hash; packaged README, LICENSE
and package.json must match the current root bytes. Validation occurs before warmups and again before
emitting the receipt. A same-version receipt from another build is not accepted.

Archive SHA-256: `360a949ff546fac2e604f463fc8e13bb7216822fcfb8f4ee0f812b1e01f354db`.

SRI: `sha512-Z5dWWNfQV9Ietb5IoNDsNg+YobtC36KXfpM7hfTKOHt4vO/vXNFOr4/fq/mU6Eo3Z5AbnPEKPFKWVlRMWgU0nQ==`.

Runtime/optional dependency sets remain empty. Measurement scripts, fixture code and these docs are
outside the package allowlist. The 99 entries are `dist/` plus `LICENSE` (1,071 B), `README.md` (5,412 B)
and `package.json` (1,969 B). `dist/` holds 96 files and 675,791 bytes: 24 compiled `.js` modules
(363,847 B) built from the 24 `src/` TypeScript modules, 24 `.d.ts` declarations (80,998 B) and 48 source
maps (230,946 B). By module directory `scanner` is largest with 20 files / 420,466 B (62.2% of `dist/`),
then `cli/notifier` 88,199 B, `detectors` 73,428 B, `cli` 32,841 B, `core` 28,088 B, `config` 20,495 B,
`reporters` 11,188 B and the four `dist/` root files 1,086 B. The largest module output is
`dist/scanner/moduleSpecifiers.js` at 164,009 B (24.3% of `dist/`, plus its 127,299 B map), then
`dist/scanner/scriptUsage.js` at 47,257 B and `dist/detectors/eslintManifestConfig.js` at 16,106 B. The
receipt keeps the ordered path/SHA-256 build map for the same 96 files; the byte aggregates above were
read from that built `dist/` tree.
The archive version is 0.2.0; this is not a publication or release
candidate receipt. No earlier exact tarball size/integrity baseline was available in the inspected
measurement receipts, so no artifact-size improvement is claimed. Packing is offline and skips hooks
only after the explicit clean build; it installs nothing. Consumer installation/CI/release coverage
remain separate gates and were not repeated for this development-only helper.

## Reproduce

Use the already installed toolchain pinned in `package.json`; no target dependencies are required.
From the repository root (POSIX shell):

```sh
pnpm run clean
pnpm run build
measurement_pack_dir=$(mktemp -d)
measurement_receipt=$(mktemp /tmp/depvitals-step94-XXXXXX.json)
npm_config_offline=true npm_config_cache="$measurement_pack_dir/cache" npm pack --ignore-scripts --json --pack-destination "$measurement_pack_dir" > "$measurement_pack_dir/pack.json"
node --expose-gc scripts/measure-scanning.mjs "$measurement_pack_dir/pack.json" > "$measurement_receipt"
rm -rf "$measurement_pack_dir"
printf '%s\n' "$measurement_receipt"
```

Keep `pack.json` and its named `.tgz` together until the runner finishes. The runner inspects this
package’s regular-file ustar contents in memory, never extracting or executing them. Unsupported
archive entry types (including links or extended headers) fail explicitly rather than being skipped.

The helper emits JSON to stdout and progress to stderr, asserts independent expected results and
unchanged input/build identities, and cleans only its generated pruning trees. Output contains the
actual environment and source hashes; another machine will produce different timings/memory and may
produce a different archive identity. The historical JSON is a static observation, not a dependency
of the runnable helper. Keep measurements separate from concurrent tests/builds, since the test
setup rebuilds `dist`. No network, comparative marketing benchmark, project execution, automatic
configuration, runtime feature, corpus-wide accuracy percentage or performance SLA is introduced.

### Review-correction validation

The receipt was regenerated after adding root-entry state and archive/build binding. Its self scan
now includes the additional development identity helper and regression test, so its source count and
input hash differ from the original measurement. Do not compare the old and new self timings as
identical workloads. The artifact is unchanged: the actual adjacent tarball reproduced the same
packed/unpacked byte counts, file set and integrity, and every packaged file matched the measured
build/root bytes at both checks.

Regression tests cover each ESLint/Jest barrier name, case-insensitive legacy JSON, a barrier that
changes hints while source preserves the exact findings, same-version stale builds, stale root files,
missing/extra entries, absent archives, bad metadata/bytes, checksum errors, unsupported linked entries
and long ustar prefix paths. These checks validate identities, not a performance threshold. Source,
CLI, dependency and packaging behavior remain unchanged.
