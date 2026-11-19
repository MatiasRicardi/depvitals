# Fixed-version DepVitals checks in GitHub Actions

This recipe targets **DepVitals 0.5.0**. It uses Node.js 22 (minimum 22.13.0),
npm and an Ubuntu Actions runner.

Install the exact version in your project and commit the generated `package-lock.json`:

```sh
npm install --save-dev --save-exact depvitals@0.5.0
```

Add the package script to your existing manifest and run it with `npm run --silent check:dependencies`
for machine-readable output. Use the command directly as a CI step to propagate the scan exit status:

```json
{
  "scripts": {
    "check:dependencies": "depvitals --format json"
  },
  "devDependencies": {
    "depvitals": "0.5.0"
  }
}
```

Copy [check-dependencies.yml](check-dependencies.yml) to `.github/workflows/check-dependencies.yml`
and place [capture-report.sh](capture-report.sh) and [verify-report.mjs](verify-report.mjs) under
`.github/depvitals/`. The workflow installs from the committed lockfile with lifecycle scripts
disabled. It captures the installed binary's output directly, then uploads the report, diagnostics
and recorded scan status from a fresh runner-temporary directory. The final step restores the
outcome after the artifact upload. A missing installation or capture leaves no valid status.

| Outcome                           | Verification exit | Artifact                                      |
| --------------------------------- | ----------------: | --------------------------------------------- |
| Clean                             |                 0 | JSON report with zero findings                |
| Dependency findings               |                 1 | JSON report with findings and category counts |
| Operational failure               |                 1 | Empty report and a diagnostic                 |
| Missing or inconsistent artifacts |                 2 | Any available files for diagnosis             |

## Optional scope diagnostics

The copied workflow keeps its ordinary JSON capture by default. To include scope diagnostics,
replace only its capture command with:

```sh
bash .github/depvitals/capture-report.sh "$REPORT_DIR" --diagnostics
```

For the minimal npm-script workflow, the optional script value is
`"check:dependencies": "depvitals --format json --diagnostics"`. Continue to invoke it with
`npm run --silent check:dependencies`; npm banners are not JSON. A zero-source scan with no findings
still exits 0 even when it reports `no-supported-sources`. Findings and operational failures still
exit 1. Capture records the CLI status for enforcement after upload; a successful capture command
alone does not mean the scan passed. Invalid or extra capture arguments exit 2 before creating an
artifact directory. Supply exactly one optional literal `--diagnostics`.

The optional object belongs in `depvitals-report.json`. The existing
`depvitals-diagnostics.txt` artifact is stderr and stays empty on a completed scan, including one
with scope notices. An operational error has an empty report and a nonempty stderr artifact;
no partial scope counts are emitted. See the [report schema](../../../schemas/report-v1.schema.json),
[diagnostic fields](../../../schemas/README.md) and [scope diagnostics and notice rules](../../reference.md#scan-scope-diagnostics).

The unchanged verifier validates the existing v1 findings/status relationship and tolerates
additional top-level fields. The byte-identical verifier shipped at v0.4.1 can read these new
scan artifacts. This reader compatibility does not add the new flag to the old producer.
Diagnostic schema validation is a separate producer/consumer check.

## Pre-release local consumer

To verify a development build, substitute an absolute path to its **local tarball** in the install
command. npm generates the matching lockfile from that tarball. Use the version shown by the
installed executable when checking the build. Keep the tarball and its local lockfile in a
temporary consumer and use the registry-pinned lockfile for the published workflow.

```sh
npm install --save-dev --save-exact --ignore-scripts --package-lock --lockfile-version=3 \
  /absolute/path/to/depvitals-candidate.tgz
npm ci --ignore-scripts --include=dev
```

The repository's package smoke tests the capture and verification commands against an isolated
consumer installed from its local tarball. GitHub artifact upload belongs to the copied workflow.
