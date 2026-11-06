# DepVitals JSON report format v1

[report-v1.schema.json](report-v1.schema.json) is the Draft 7 schema for dependency scans and exact-package explanations. It is a data artifact, not a JavaScript API or a runtime validation dependency. The schema version is independent of the CLI release version; `tool.version` identifies the actual producing version.

A report is one UTF-8 JSON document, indented by two spaces, followed by one LF. Its fields are `schemaVersion`, `tool`, `mode`, `project`, `scope`, `findings`, `counts`, `packages` and `query`, in that order. There are no timestamps, durations, banners or error-shaped documents. An operational failure produces no report.

`project.root` is the absolute native-platform root. Evidence filenames are relative paths using `/` separators, preserving casing and literal filename characters. JSON escaping preserves the original strings, including control characters and backslashes; terminal display escaping is separate. Changing the checkout root changes document identity.

`scope` contains the actual source extensions, fixed excluded directory names and effective normalized `ignorePaths` and `ignoreDependencies`. It describes supported discovery, not proof that a package can safely be removed. Source evidence can suppress unused findings and produce missing findings. Script/config evidence only credits eligible declared packages. Exclusions are policy, not evidence.

A package retains all four declaration memberships, status, dependency exclusion, underlying findings before exclusions, visible findings after exclusions and genuine source/script/config evidence. Unused dependencies and devDependencies remain separate, including when a name occurs in both. Peer/optional-only declarations are not unused candidates. Exclusion preserves evidence and underlying findings while hiding visible findings.

In scan mode, `query` is null. In explanation mode, exactly one package and its visible findings/counts are reported, with `{ "packageName": "...", "known": true }` or false. An absent valid query is a completed unknown record; exclusion-only names are known. Unrelated findings are omitted, but unrelated retained-input errors still prevent completion of the scan.

Consumers should ignore unknown object properties. In addition to schema validation, check that counts equal corresponding visible array lengths, packages agree with findings/status, query identity matches its single record and all prescribed sorting/identity rules hold. Schema validation alone cannot prove these relationships or the correctness of source locations.

The six [normative examples](examples/README.md) illustrate target-release documents. They are not evidence of release publication or feature availability in an earlier installed CLI. No package JavaScript entrypoint is introduced.
