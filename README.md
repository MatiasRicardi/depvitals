# DepVitals

[![npm version](https://img.shields.io/npm/v/depvitals)](https://www.npmjs.com/package/depvitals)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime_dependencies-0-brightgreen)](https://github.com/MatiasRicardi/depvitals/blob/main/package.json)
[![CI](https://github.com/MatiasRicardi/depvitals/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MatiasRicardi/depvitals/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/MatiasRicardi/depvitals/graph/badge.svg?branch=main)](https://codecov.io/gh/MatiasRicardi/depvitals)
[![CodeQL](https://github.com/MatiasRicardi/depvitals/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/MatiasRicardi/depvitals/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/MatiasRicardi/depvitals/blob/main/LICENSE)

DepVitals finds unused and undeclared npm dependencies in single-package JavaScript and TypeScript projects. It uses a custom static scanner, needs no configuration to get started and has **zero runtime dependencies**.

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

**Missing means undeclared, not uninstalled. Unused is not proof of safe removal.** Review findings before editing your manifest. Peer and optional dependencies suppress missing findings and are never reported unused.

Reports use stdout; operational errors use stderr without a partial report. Exit **0** means clean/help/version; **1** means findings/errors. An optional update notice can use stderr without changing the status.

## Optional configuration (unreleased)

Create `depvitals.config.json` at the scanned project root:

```json
{
  "ignorePaths": ["examples", "src/generated"],
  "ignoreDependencies": ["some-adapter"]
}
```

`ignorePaths` excludes literal source paths/subtrees; `ignoreDependencies` hides exact package names from findings. No globs. Exclusions narrow what a clean report means; excluding the only source reference can make a dependency unused. See the [configuration reference](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md#optional-project-configuration) for validation and precedence.

## Scope and privacy

Scans cover JS/TS, JSX/TSX and declaration files, literal ESM/CommonJS references, supported script commands and bounded ESLint/Jest hints. Only source evidence creates missing findings. There is no workspace aggregation, alias/tsconfig resolution, blanket `@types` inference, JSON output or automatic fix; see [supported patterns and limits](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md).

Core analysis is offline and never executes or modifies the project or inspects `node_modules`. After completed interactive scans, an optional update check requests public metadata for **DepVitals itself**, caches it outside the project and uploads no project data. CI, non-TTY, help/version and failed scans skip it. Set `DEPVITALS_NO_UPDATE_CHECK=1` to disable it; see [privacy and shell examples](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md#update-notice-and-privacy).

[Technical reference](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md) · [Contributing](https://github.com/MatiasRicardi/depvitals/blob/main/CONTRIBUTING.md) · [Changelog](https://github.com/MatiasRicardi/depvitals/blob/main/CHANGELOG.md) · [MIT license](https://github.com/MatiasRicardi/depvitals/blob/main/LICENSE)
