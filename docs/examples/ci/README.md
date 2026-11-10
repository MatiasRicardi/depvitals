# Fixed-version DepVitals checks in GitHub Actions

This recipe targets **DepVitals 0.4.1 after publication**. It uses Node.js 22 (minimum 22.13.0),
npm and an Ubuntu Actions runner.

Install the exact version in your project and commit the generated `package-lock.json`:

```sh
npm install --save-dev --save-exact depvitals@0.4.1
```

Add the package script to your existing manifest and run it with `npm run --silent check:dependencies`
for machine-readable output. Use the command directly as a CI step to propagate the scan exit status:

```json
{
  "scripts": {
    "check:dependencies": "depvitals --format json"
  },
  "devDependencies": {
    "depvitals": "0.4.1"
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

Before publication, substitute an absolute path to the **local candidate tarball** in the install
command. npm generates the matching lockfile from that tarball. Use the version shown by the
installed executable when checking the candidate. Keep the tarball and its local lockfile in a
temporary consumer and use the registry-pinned lockfile for the published workflow.

```sh
npm install --save-dev --save-exact --ignore-scripts /absolute/path/to/depvitals-candidate.tgz
```

The repository's package smoke tests the capture and verification commands against an isolated
consumer installed from its local tarball. GitHub artifact upload belongs to the copied workflow.
