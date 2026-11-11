# DepVitals JSON report format v1

[report-v1.schema.json](report-v1.schema.json) is the Draft 7 schema for dependency scans and exact-package explanations. It is a data artifact, not a JavaScript API or a runtime validation dependency. The schema version is independent of the CLI release version; `tool.version` identifies the actual producing version.

A report is one UTF-8 JSON document, indented by two spaces, followed by one LF. Its fields are `schemaVersion`, `tool`, `mode`, `project`, `scope`, `findings`, `counts`, `packages` and `query`, in that order. Diagnostic scans append the optional `diagnostics` object after `query`. There are no timestamps, durations, banners or error-shaped documents. An operational failure produces no report.

`project.root` is the absolute native-platform root. Evidence filenames are relative paths using `/` separators, preserving casing and literal filename characters. JSON escaping preserves the original strings, including control characters and backslashes; terminal display escaping is separate. Changing the checkout root changes document identity.

`scope` contains the actual source extensions, fixed excluded directory names and effective normalized `ignorePaths` and `ignoreDependencies`. It describes supported discovery, not proof that a package can safely be removed. Source evidence can suppress unused findings and produce missing findings. Script/config evidence only credits eligible declared packages. Exclusions are policy, not evidence.

A package retains all four declaration memberships, status, dependency exclusion, underlying findings before exclusions, visible findings after exclusions and genuine source/script/config evidence. Unused dependencies and devDependencies remain separate, including when a name occurs in both. Peer/optional-only declarations are not unused candidates. Exclusion preserves evidence and underlying findings while hiding visible findings.

In scan mode, `query` is null. In explanation mode, exactly one package and its visible findings/counts are reported, with `{ "packageName": "...", "known": true }` or false. An absent valid query is a completed unknown record; exclusion-only names are known. Unrelated findings are omitted, but unrelated retained-input errors still prevent completion of the scan.

Consumers should ignore unknown object properties. In addition to schema validation, check that counts equal corresponding visible array lengths, packages agree with findings/status, query identity matches its single record and all prescribed sorting/identity rules hold. Schema validation alone cannot prove these relationships or the correctness of source locations.

## Ordering and duplicate identity

All string comparisons use case-sensitive ECMAScript lexicographic order over UTF-16 code units, independent of locale. Do not lowercase or Unicode-normalize strings. Findings and each scope array are sorted and duplicate-free. Packages are unique by exact `name` and sorted by that string; an empty scanned name remains valid data.

Declaration groups always follow `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`. Finding identifiers in package `underlyingFindings` and `findings` always follow `unusedDependencies`, `unusedDevDependencies`, `missingDependencies`. These arrays have no duplicates. The three fields in the envelope's findings/counts objects follow that same category order. Count each category independently: a name unused in both dependency groups contributes one to each corresponding count.

Within each package, evidence is ordered by kind (source, script, config), then by `file` using the string comparison above, then by these kind-specific fields, in order:

| Kind   | Remaining sort keys                                                                                                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| source | Numeric `position.offset`; reference rank `import`, `export-from`, `dynamic-import`, `require`; `specifier`; numeric `position.line`; numeric `position.column`. The final two keys break ties deterministically. |
| script | `pointer`; numeric `occurrence`; via rank `direct`, `mapping`, `runner`, `node-preload`; `command`.                                                                                                               |
| config | `pointer`; detector rank `eslint`, `jest`; `value`.                                                                                                                                                               |

Deduplicate only complete semantic records of the same kind. Source identity includes `kind`, `file`, `reference`, `specifier` and all three position fields. Script identity includes `kind`, `file`, `pointer`, `command`, `via` and `occurrence`. Config identity includes `kind`, `file`, `pointer`, `value` and `detector`. Object-property insertion order and unrecognized additive properties do not change these identities. Distinct offsets, script ordinals, config pointers or kinds remain distinct even when they name the same package or selector. Do not deduplicate solely by package name or specifier.

## Evidence meaning and position units

Source records have fields `kind`, `file`, `reference`, `specifier`, `position`, in that order; position has `offset`, `line`, `column`. The specifier is the decoded recognized string before package-root normalization. A subpath may therefore differ from the owning package name.

`position.offset` is the zero-based UTF-16 code-unit offset of the opening quote of the specifier literal in the original source text decoded as UTF-8. It points to the quote, not the import/require keyword. Lines and columns are one-based; columns count UTF-16 code units, not bytes, Unicode scalar values or display width. A tab adds one column and a surrogate pair adds two. LF, CR, CRLF, U+2028 and U+2029 end a line, with CRLF counted once. Do not normalize line endings or strip a BOM before measuring: both CRLF code units participate in offsets, and a BOM participates in offsets/columns. Escapes are decoded in `specifier` but positions still refer to the original source spelling. No end position or JSON-config character position is implied.

Evidence filenames are lexical project-relative paths with `/` separators and no leading slash, empty component, `.` or `..` component. Preserve actual casing; a literal backslash in a POSIX filename remains data. Do not resolve filesystem targets to interpret a display path.

Script fields are `kind`, `file`, `pointer`, `command`, `via`, `occurrence`. The file is `package.json`; the pointer identifies the actual script key. `command` is the dequoted semantic selector: executable for direct/mapped commands, immediate package argument for a supported runner, or module selector without the option prefix for a supported Node preload. It is not the complete script text or an installed executable path. `occurrence` is a zero-based ordinal of accepted external candidate events across the whole script, before declaration filtering, deduplication or dependency exclusions; it resets per script key. Undeclared external candidates consume ordinals; internal/builtin/unsupported selectors and discarded candidates do not. Repeated accepted selectors keep distinct ordinals. Script credit remains gated to dependencies/devDependencies and never creates missing findings.

Config fields are `kind`, `file`, `pointer`, `value`, `detector`. The filename preserves the actual selected configuration filename's casing. `value` is the exact recognized string, not inferred source usage. The detector is `eslint` or `jest`; only eligible declared packages gain config evidence. Neither config nor script records claim source line/column positions.

Pointers are RFC 6901 data pointers, not URL fragments: escape each object-key token's `~` as `~0` and `/` as `~1`; array indices are zero-based decimal without leading zeroes. A pointer identifies the exact string field/array element, not a config object or transformer options. Preserve original pointer strings through JSON escaping; do not percent-encode them or interpret literal escape text as a control character.

The [normative examples](examples/README.md) illustrate target-release documents. They are not evidence of release publication or feature availability in an earlier installed CLI. No package JavaScript entrypoint is introduced.

## Optional scan diagnostics

An explicitly requested full-scan projection appends `diagnostics` with
`sourceFilesScanned`, `nestedPackageSourceFiles` and `notices`, in that order.
The counts are integers from 0 through 9007199254740991. They describe successfully processed
supported sources within the effective discovery scope. Nested sources retain the selected
root's dependency inventory. Explanations omit this object.

The notice list contains applicable codes once each in the following order.

| Code                    | Meaning                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-supported-sources`  | Zero supported source files were scanned. Script and config evidence can still contribute.                                                  |
| `nested-package-inputs` | At least one scanned source belongs to a manifest below the selected root.                                                                  |
| `workspace-declared`    | The root manifest declares a nonempty string array in `workspaces` or `workspaces.packages`. Patterns are descriptive and are not expanded. |

Consumers check that the nested count does not exceed the total, that the first notice appears
exactly when the total is zero, and that the second appears exactly when the nested count is
positive. They also check notice order. Draft 7 validates structure, ranges, known codes and
uniqueness. The diagnostics object accepts future optional properties. Existing v1 consumers
can ignore this added top-level property.

[scan-diagnostics.json](examples/scan-diagnostics.json) shows a clean workspace declaration with
zero sources and illustrative tool version 0.5.0. Actual reports use their package metadata version.
The query schema accepts existing scoped names such as `@scope/_demo` and `@scope/-demo`,
with the same 214-character bound and exact-root grammar used by the CLI.
