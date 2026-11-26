# DepVitals

[![npm version](https://img.shields.io/npm/v/depvitals)](https://www.npmjs.com/package/depvitals)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime_dependencies-0-brightgreen)](https://github.com/MatiasRicardi/depvitals/blob/main/package.json)
[![CI](https://github.com/MatiasRicardi/depvitals/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MatiasRicardi/depvitals/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/MatiasRicardi/depvitals/graph/badge.svg?branch=main)](https://codecov.io/gh/MatiasRicardi/depvitals)
[![CodeQL](https://github.com/MatiasRicardi/depvitals/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/MatiasRicardi/depvitals/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/MatiasRicardi/depvitals/blob/main/LICENSE)

DepVitals is a lightweight, [Depcheck](https://github.com/depcheck/depcheck)-inspired **npm dependency analyzer for Node.js, JavaScript and TypeScript projects**. It finds **unused dependencies, unused devDependencies and missing (undeclared) dependencies** using a custom static scanner with **zero runtime dependencies**.

Designed for fast, zero-config dependency checks during development, maintenance and CI, its CLI can also be used in scripts and AI coding-agent workflows. It analyzes one project root at a time; review findings before changing `package.json`.

## From scan to decision

Run `depvitals ./project`. For a project that declares `demo-unused` and contains
`import 'demo-missing';` in `index.mjs`, the scan prints:

```text
DepVitals

Unused dependencies (1)
  demo-unused

Missing dependencies (1)
  demo-missing
```

Run `depvitals ./project --explain demo-missing` to locate the reference. The explanation
includes this excerpt:

```text
Package: demo-missing
Status: missing
```

```text
Evidence (1)
  source "index.mjs":1:8 import "demo-missing"
```

Both commands exit **1** for this project. Open `index.mjs:1:8` and check whether that import
belongs in the project before declaring the dependency. Review the uses of `demo-unused`
and test the project before removing it.

See the [CLI reference](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md#cli-and-json-reports),
[JSON schema and examples](https://github.com/MatiasRicardi/depvitals/blob/main/schemas/README.md),
[Depcheck migration guide](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md#manual-migration-from-depcheck)
and [v0.6.0 release notes](https://github.com/MatiasRicardi/depvitals/blob/main/docs/releases/v0.6.0.md).

## Quick start

Requires **Node.js 22.13.0 or newer**. Scan the current directory containing `package.json`, or pass a project path:

```sh
npx depvitals
npx depvitals ./path/to/project
```

### Install globally

```sh
npm i -g depvitals
depvitals
depvitals ./path/to/project
```

Use `depvitals --help` or `depvitals --version` for standalone help/version; the same flags work with `npx depvitals`.

These commands use the npm release. Documentation on `main` can describe unreleased changes; see the [changelog](https://github.com/MatiasRicardi/depvitals/blob/main/CHANGELOG.md). To try the development checkout, [build and run the local CLI](https://github.com/MatiasRicardi/depvitals/blob/main/CONTRIBUTING.md#local-setup).

## Results

| Finding                | Meaning                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Unused dependencies    | Declared in `dependencies`, without supported usage evidence.                          |
| Unused devDependencies | The same check for `devDependencies`.                                                  |
| Missing dependencies   | Referenced by supported source imports/exports/requires, but undeclared in all groups. |

**Missing means undeclared.** DepVitals checks the manifest and supported evidence. Review each unused finding before editing your manifest. Peer and optional dependencies suppress missing findings and are never reported unused.

Reports use stdout; operational errors use stderr without a partial report. Exit **0** means clean/help/version; **1** means findings/errors. An optional update notice can use stderr without changing the status.

### Understand scan scope

Use `--diagnostics` for terminal
output or combine it with `--format json`.

For a small reproduced example, create `scope-demo/package.json` containing `{}`,
`scope-demo/packages/child/package.json` containing
`{"dependencies":{"child-only":"1"}}`, and `scope-demo/packages/child/index.mjs`
containing `import 'child-only';` followed by a newline. Run from outside `scope-demo`:

```sh
depvitals ./scope-demo --diagnostics
```

```text
DepVitals

Missing dependencies (1)
  child-only

Scan diagnostics
  Source files scanned: 1
  Nested-package source files: 1
  Some source files belong to nested packages. Findings use the selected root inventory. Scan a nested package separately to use its inventory.
```

The command exits **1**: the selected parent inventory does not declare `child-only`.
Scan `depvitals ./scope-demo/packages/child --diagnostics` to use the child's declaration;
that scan is clean and exits **0**. If omitting the child is intentional policy, use a literal
`ignorePaths` rule and review the narrower scope.

```sh
depvitals ./scope-demo --format json --diagnostics > scope-report.json
```

The JSON command also exits **1** and appends a scope object to the report. A clean scan with
zero supported sources is possible; supported script/config hints may still contribute evidence.
Workspace declarations provide context without discovering or aggregating members. See the
[scope facts and notice examples](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md#scan-scope-diagnostics),
[reviewed six-project comparison](https://github.com/MatiasRicardi/depvitals/blob/main/docs/compatibility/v0.6.0.md)
and [v0.6.0 release notes](https://github.com/MatiasRicardi/depvitals/blob/main/docs/releases/v0.6.0.md).

## JSON reports and package explanations

DepVitals supports terminal and JSON package explanations. To use a development checkout, run
`node /path/to/depvitals/dist/cli/index.js` in place of `depvitals` after
[building the development checkout](https://github.com/MatiasRicardi/depvitals/blob/main/CONTRIBUTING.md#local-setup).

The commands below use the project from [the walkthrough](#from-scan-to-decision). Run them
from outside the selected project.

```sh
depvitals ./project --format json > depvitals-report.json
depvitals ./project --explain demo-missing
depvitals --format json --explain demo-missing ./project
```

An explanation reports one exact package. Its exit status follows that package's result. Use a full
scan to enforce a project-wide check. DepVitals v0.6.0 emits `schemaVersion: 2` for every completed
JSON scan and explanation. Validate these reports with the [report v2 schema and examples](https://github.com/MatiasRicardi/depvitals/blob/main/schemas/README.md#report-v2-semantic-contract),
shipped under `schemas/`. `tool.version` identifies the CLI package version.
For the historical v0.5.0 producer, use its [report v1 schema and guide](https://github.com/MatiasRicardi/depvitals/tree/v0.5.0/schemas).

## CI with a fixed version

For JSON v2, pin v0.6.0 once it is available on npm. Before publication, use a tarball built
from the current checkout with a temporary lockfile. Commit the registry-generated lockfile
for CI when you adopt the published version.

```sh
npm install --ignore-scripts --save-dev --save-exact depvitals@0.6.0
```

To rehearse before publication, substitute the path to the local tarball for `depvitals@0.6.0`.

Add this entry to `scripts` in `package.json`:

```json
{ "check:dependencies": "depvitals --format json" }
```

In CI, install from the lockfile and run the check directly so its exit status reaches the job.

```sh
npm ci --ignore-scripts --include=dev
npm run --silent check:dependencies
```

The [v2 CI recipe](https://github.com/MatiasRicardi/depvitals/blob/main/docs/examples/ci/README.md)
captures and uploads the report, diagnostics and status, then enforces the result with the
installed v2 schema and pinned Ajv. When upgrading, update the DepVitals pin, the copied recipe
files and the lockfile in the same change. Use `--diagnostics` to include scope facts. Notices alone do
not fail a check. For a historical JSON v1 workflow, pair the exact `depvitals@0.5.0` pin with its
[tagged v1 recipe](https://github.com/MatiasRicardi/depvitals/tree/v0.5.0/docs/examples/ci).

## Optional configuration

Requires DepVitals **0.3.0 or newer**. Create `depvitals.config.json` at the scanned project root:

```json
{
  "ignorePaths": ["examples", "src/generated"],
  "ignoreDependencies": ["some-adapter"]
}
```

`ignorePaths` excludes literal source paths/subtrees; `ignoreDependencies` hides exact package names from findings. No globs. Exclusions narrow what a clean report means; excluding the only source reference can make a dependency unused. See the [configuration reference](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md#optional-project-configuration) for validation and precedence.

The [packaged editor schema](https://github.com/MatiasRicardi/depvitals/blob/main/schemas/depvitals-config.schema.json)
can check the two keys in an editor. Follow the [workspace association example](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md#editor-validation),
using the installed local asset or the version-pinned URL. Keep `$schema` out of the project
configuration; the CLI rejects unknown keys and still enforces complete literal-path rules.

## Scope and privacy

Scans cover JS/TS, JSX/TSX and declaration files, literal ESM/CommonJS references, supported
script commands and bounded ESLint/Jest hints. DepVitals v0.6.0 also recognizes an explicit
package selector in the selected root's `tsconfig.json` `extends`. It credits an exact declared
package and shows the selector in `--explain`. Only source evidence creates missing findings.
Tsconfig inheritance, path aliases, workspace aggregation, blanket `@types` inference and
automatic fixes are outside the scope. See the
[TypeScript configuration rules](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md#root-typescript-configuration)
and [v0.6.0 release notes](https://github.com/MatiasRicardi/depvitals/blob/main/docs/releases/v0.6.0.md).

Core analysis is offline and never executes or modifies the project or inspects `node_modules`. After completed interactive scans, an optional update check requests public metadata for **DepVitals itself**, caches it outside the project and uploads no project data. CI, non-TTY, help/version and failed scans skip it. JSON scans and all explanations also skip it before any cache or network access. The `--diagnostics` mode bypasses it in both output formats, including interactive terminals. Set `DEPVITALS_NO_UPDATE_CHECK=1` to disable it; see [privacy and shell examples](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md#update-notice-and-privacy).

[Technical reference](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md) · [Contributing](https://github.com/MatiasRicardi/depvitals/blob/main/CONTRIBUTING.md) · [Changelog](https://github.com/MatiasRicardi/depvitals/blob/main/CHANGELOG.md) · [MIT license](https://github.com/MatiasRicardi/depvitals/blob/main/LICENSE)
