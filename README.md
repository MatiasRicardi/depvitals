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
and [v0.4.0 release notes](https://github.com/MatiasRicardi/depvitals/releases/tag/v0.4.0).

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

## JSON reports and package explanations

These examples require **v0.4.0 or newer**. To try them from a checkout, use
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
scan to enforce a project-wide check. The v0.4.0 [report schema and examples](https://github.com/MatiasRicardi/depvitals/blob/main/schemas/README.md)
are shipped in the npm package under `schemas/`. See the [CLI and report contract](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md#cli-and-json-reports).

## CI with a fixed version

Install the exact version as a development dependency and commit the generated lockfile.

```sh
npm install --save-dev --save-exact depvitals@0.4.1
```

Add this entry to `scripts` in `package.json`:

```json
{ "check:dependencies": "depvitals --format json" }
```

In CI, install from the lockfile and run the check directly so its exit status reaches the job.

```sh
npm ci --ignore-scripts --include=dev
npm run --silent check:dependencies
```

Use the [CI recipe](https://github.com/MatiasRicardi/depvitals/blob/main/docs/examples/ci/README.md)
to capture and upload the report, diagnostics and status. The recipe also shows how to test a
candidate from a local tarball before it is available on npm.

## Optional configuration

Requires DepVitals **0.3.0 or newer**. Create `depvitals.config.json` at the scanned project root:

```json
{
  "ignorePaths": ["examples", "src/generated"],
  "ignoreDependencies": ["some-adapter"]
}
```

`ignorePaths` excludes literal source paths/subtrees; `ignoreDependencies` hides exact package names from findings. No globs. Exclusions narrow what a clean report means; excluding the only source reference can make a dependency unused. See the [configuration reference](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md#optional-project-configuration) for validation and precedence.

## Scope and privacy

Scans cover JS/TS, JSX/TSX and declaration files, literal ESM/CommonJS references, supported script commands and bounded ESLint/Jest hints. Only source evidence creates missing findings. There is no workspace aggregation, alias/tsconfig resolution, blanket `@types` inference or automatic fix; see [supported patterns and limits](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md).

Core analysis is offline and never executes or modifies the project or inspects `node_modules`. After completed interactive scans, an optional update check requests public metadata for **DepVitals itself**, caches it outside the project and uploads no project data. CI, non-TTY, help/version and failed scans skip it. In v0.4.0, JSON scans and all explanations also skip it before any cache or network access. Set `DEPVITALS_NO_UPDATE_CHECK=1` to disable it; see [privacy and shell examples](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md#update-notice-and-privacy).

[Technical reference](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md) · [Contributing](https://github.com/MatiasRicardi/depvitals/blob/main/CONTRIBUTING.md) · [Changelog](https://github.com/MatiasRicardi/depvitals/blob/main/CHANGELOG.md) · [MIT license](https://github.com/MatiasRicardi/depvitals/blob/main/LICENSE)
