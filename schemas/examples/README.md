# Report format v1 examples

The six original normative examples describe the target v0.4.0 release. Their conceptual root is `/example/project` and their illustrative `tool.version` is `0.4.0`; actual reports use the real selected root and installed tool version. They do not claim that an earlier CLI already accepts format or explanation options. See the [schema](../report-v1.schema.json) and [format description](../README.md).

| Document                                               | Scenario and intended exit                                                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [scan-clean.json](scan-clean.json)                     | Empty manifest and no supported source; scan exit 0.                                                                                                                                                                     |
| [scan-findings.json](scan-findings.json)               | Dependencies declare `unused`, devDependencies declare `unused-tool`; `src/index.ts` contains `import item from 'missing';` and a final LF. Scan exit 1. The quote is at zero-based UTF-16 offset 17, line 1, column 18. |
| [explain-missing.json](explain-missing.json)           | Query `missing` in that same project; exit 1, excluding unrelated unused findings.                                                                                                                                       |
| [explain-excluded.json](explain-excluded.json)         | Dependency `unused`, no sources, exact ignoreDependencies entry `unused`; query exit 0, preserving its underlying unused finding.                                                                                        |
| [explain-unknown.json](explain-unknown.json)           | Empty project, query `absent`; completed unknown record and exit 1.                                                                                                                                                      |
| [explain-node-preload.json](explain-node-preload.json) | Dev dependency `preload` used by the selected Node preload recognition described below; query exit 0.                                                                                                                    |

The Node-preload example assumes this manifest and an empty `entry.cjs`:

```json
{
  "devDependencies": { "preload": "1" },
  "scripts": {
    "check/node~": "unlisted-tool && node --import=preload/esm --import=preload/esm ./entry.cjs"
  }
}
```

The candidate ordinals are unlisted-tool=0, node=1, preload=2 and preload=3 before declaration filtering. The undeclared commands create no package records or missing findings. The two preload selectors retain distinct script occurrences and the escaped pointer `/scripts/check~1node~0`. Their module selector is `preload/esm`, owned by package `preload`, without installed resolution or execution. This example describes the target recognition; serializing supplied facts alone does not establish that a particular CLI version collects them.

Invalid manifest/config/source inputs intentionally have no report fixture. Their expected stdout is empty, stderr identifies the error and exit is 1. They must not be represented as successful clean documents.

## Scan diagnostics example

[scan-diagnostics.json](scan-diagnostics.json) describes a full scan of a root manifest containing
`{"workspaces":["packages/*"]}` with no supported source files. Its illustrative version is 0.5.0.
The expected exit is 0. The optional `diagnostics` property follows `query` and contains
`sourceFilesScanned`, `nestedPackageSourceFiles` and `notices`, in that order.

Notice codes appear once each in this order. `no-supported-sources` means the source count is
zero. `nested-package-inputs` means the nested count is positive and findings still use the
selected root inventory. `workspace-declared` describes a recognized root declaration without
expanding members. The example includes the first and third codes.

In addition to schema validation, consumers check that the nested count is at most the total,
that the first two codes match their count predicates and that notice order is correct.
Explanations omit diagnostics. Existing v1 consumers that ignore unknown properties accept
this extension. The [format description](../README.md#optional-scan-diagnostics) defines
the optional projection and its structural bounds.
