# DepVitals

DepVitals finds unused and undeclared npm dependencies in single-package JavaScript and TypeScript projects. It is a zero-config Node.js CLI with a custom static scanner and no runtime dependencies.

[Depcheck](https://github.com/depcheck/depcheck)-inspired, DepVitals focuses on dependency declarations and supported usage evidence. Use it to review dependencies during maintenance or before a release; review each finding before changing your manifest.

Documentation on `main` can be ahead of the [published npm package](https://www.npmjs.com/package/depvitals). Check the [changelog](https://github.com/MatiasRicardi/depvitals/blob/main/CHANGELOG.md) for release-specific behavior.

## Quick start

Requires **Node.js 22.13.0 or newer**. From a directory containing `package.json`:

```sh
npx depvitals
```

Scan an explicit project path, or request standalone help/version:

```sh
npx depvitals ./path/to/project
npx depvitals --help
npx depvitals --version
```

These commands run the npm release. For development-branch behavior, build and run the local CLI as described in [Contributing](https://github.com/MatiasRicardi/depvitals/blob/main/CONTRIBUTING.md).

## Understand the results

| Finding                | Meaning                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Unused dependencies    | Entries in `dependencies` with no supported source, script or configuration usage evidence.                  |
| Unused devDependencies | The same check for `devDependencies`.                                                                        |
| Missing dependencies   | Packages referenced by supported source imports/requires but absent from every dependency declaration group. |

**Missing means undeclared, not uninstalled.** DepVitals does not inspect `node_modules`. **Unused is not proof of safe removal**: indirect or unsupported usage may exist. Peer and optional declarations suppress missing findings and are never reported as unused.

A scan can report:

```text
DepVitals

Unused dependencies (1)
  lodash

Unused devDependencies (1)
  echo-only

Missing dependencies (1)
  undeclared-pkg
```

Reports go to stdout; operational errors go to stderr. Exit status is **0** for a clean scan, help or version, and **1** for findings or errors. An eligible update notice may additionally use stderr without changing the status.

## Coverage and fit

DepVitals recognizes literal ESM/CommonJS imports, exports and requires in JavaScript, TypeScript, JSX/TSX and declaration files. It normalizes scoped/subpath imports and excludes Node builtins and internal paths.

Supported `package.json` commands and bounded ESLint/Jest configuration hints can prevent unused findings for declared packages. Only source evidence creates missing findings. See the [technical reference](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md) for supported patterns, precedence and exclusions.

## Limits and update check

Analysis covers one project root, without workspace aggregation, alias/tsconfig resolution or blanket `@types` inference. The scanner is not a full compiler or resolver. Dynamic references can be missed; generated/vendor directories are excluded using fixed rules. There is no JSON output, public analyzer API, per-package explanation or automatic fix.

Core analysis is offline and never executes or modifies the analyzed project. After a completed interactive scan, an optional, bounded update check can request public metadata for **DepVitals itself** and cache it outside the project for about 24 hours. It uploads no source or dependency list and adds no telemetry. CI, non-TTY, help/version and failed scans skip the check. Set `DEPVITALS_NO_UPDATE_CHECK=1` to disable it; the [reference](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md#update-notice-and-privacy) shows POSIX and PowerShell examples.

## More

[Technical reference](https://github.com/MatiasRicardi/depvitals/blob/main/docs/reference.md) · [Contributing](https://github.com/MatiasRicardi/depvitals/blob/main/CONTRIBUTING.md) · [Changelog](https://github.com/MatiasRicardi/depvitals/blob/main/CHANGELOG.md) · [npm](https://www.npmjs.com/package/depvitals) · [Repository](https://github.com/MatiasRicardi/depvitals)

[MIT license](https://github.com/MatiasRicardi/depvitals/blob/main/LICENSE).
