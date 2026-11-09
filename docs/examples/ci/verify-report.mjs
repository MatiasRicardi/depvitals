import { readFileSync } from 'node:fs';

const categories = ['unusedDependencies', 'unusedDevDependencies', 'missingDependencies'];
const scopeKeys = ['sourceExtensions', 'excludedDirectories', 'ignorePaths', 'ignoreDependencies'];
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

function readArtifacts(paths) {
  if (paths.length !== 3) throw new Error('Expected report, diagnostics and status paths.');
  try {
    return paths.map((path) => readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Required analysis artifact is missing or unreadable.');
  }
}

function verifyPackageFindings(report) {
  const remaining = new Map(categories.map((key) => [key, new Set(report.findings[key])]));
  for (const [key, names] of remaining) {
    if (names.size !== report.counts[key]) throw new Error('Duplicate report findings.');
  }

  const seen = new Set();
  for (const pkg of report.packages) {
    if (typeof pkg?.name !== 'string' || seen.has(pkg.name) || !strings(pkg.findings)) {
      throw new Error('Invalid package findings.');
    }
    seen.add(pkg.name);
    for (const category of pkg.findings) {
      if (!remaining.get(category)?.delete(pkg.name)) {
        throw new Error('Package findings disagree with report findings.');
      }
    }

    const expected = pkg.findings.includes('missingDependencies')
      ? ['missing']
      : pkg.findings.length > 0
        ? ['unused']
        : ['used', 'declared', 'excluded'];
    if (!expected.includes(pkg.status)) throw new Error('Package status disagrees with findings.');
  }

  if ([...remaining.values()].some((names) => names.size > 0)) {
    throw new Error('Report findings disagree with package findings.');
  }
}

function verify(paths) {
  const [stdout, diagnostics, status] = readArtifacts(paths);
  if (status !== '0\n' && status !== '1\n') throw new Error('Invalid scan status.');
  if (status === '1\n' && stdout === '' && diagnostics.trim() !== '') {
    console.error('DepVitals analysis failed. See the diagnostics artifact.');
    return 1;
  }
  if (diagnostics !== '') throw new Error('Unexpected diagnostics for a completed scan.');

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error('Expected one complete JSON report.');
  }

  if (
    report?.schemaVersion !== 1 ||
    report.mode !== 'scan' ||
    report.query !== null ||
    report.tool?.name !== 'depvitals' ||
    typeof report.tool.version !== 'string' ||
    report.tool.version.trim() === '' ||
    typeof report.project?.root !== 'string' ||
    report.project.root === '' ||
    !scopeKeys.every((key) => strings(report.scope?.[key])) ||
    !Array.isArray(report.packages)
  ) {
    throw new Error('Expected a DepVitals v1 scan report.');
  }

  if (
    !categories.every(
      (key) =>
        strings(report.findings?.[key]) && report.counts?.[key] === report.findings[key].length,
    )
  ) {
    throw new Error('Invalid findings or counts.');
  }
  verifyPackageFindings(report);
  const [unused, unusedDev, missing] = categories.map((key) => report.counts[key]);
  const hasFindings = unused > 0 || unusedDev > 0 || missing > 0;
  if (status !== (hasFindings ? '1\n' : '0\n')) {
    throw new Error('Scan status disagrees with report findings.');
  }
  if (hasFindings) {
    console.error(
      `DepVitals findings: ${unused} unused, ${unusedDev} unused dev, ${missing} missing.`,
    );
    return 1;
  }
  console.log('DepVitals scan passed.');
  return 0;
}

try {
  process.exitCode = verify(process.argv.slice(2));
} catch (error) {
  console.error(`Invalid DepVitals analysis artifacts. ${error.message}`);
  process.exitCode = 2;
}
