# Report format v2 examples

These illustrative v0.6.0 documents conform to the [Draft 7 schema](../../report-v2.schema.json).
The selected root is `/example/project`. The report version records the wire format.
`tool.version` records the CLI package version.

| Document                                                             | Scenario and intended exit                                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [scan-clean.json](scan-clean.json)                                   | Empty manifest and no source. Exit 0.                                                                                                                                                      |
| [scan-findings.json](scan-findings.json)                             | The ordinary findings scenario from the [v1 examples](../README.md), with its source position intact. Exit 1.                                                                              |
| [scan-diagnostics.json](scan-diagnostics.json)                       | A root with workspaces, no supported source and a malformed root `tsconfig.json`. The skipped notice follows the earlier notices. Exit 0.                                                  |
| [explain-typescript-used.json](explain-typescript-used.json)         | Dev dependency `@scope/shared` is used through the scalar selector `@scope/shared/node22.json`. Exit 0.                                                                                    |
| [explain-typescript-excluded.json](explain-typescript-excluded.json) | The same dependency is excluded through the exact ignore list. The selector is item 1 in `["./local.json", "@scope/shared/node22.json"]`, so the retained pointer is `/extends/1`. Exit 0. |

`typescript` evidence identifies a decoded selector in the selected root's `tsconfig.json`.
The [v2 semantic contract](../../README.md#report-v2-semantic-contract) defines package matching,
findings consistency, evidence ordering and the conditions for `tsconfig-skipped`.
