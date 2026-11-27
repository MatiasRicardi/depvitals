import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const reportDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const categories = ['unusedDependencies', 'unusedDevDependencies', 'missingDependencies'];
const noticeOrder = [
  'no-supported-sources',
  'nested-package-inputs',
  'workspace-declared',
  'tsconfig-skipped',
];

function readArtifacts(paths) {
  if (paths.length !== 3) throw new Error('Expected report, diagnostics and status paths.');
  try {
    const [report, diagnostics, status] = paths;
    return [readFileSync(report), readFileSync(diagnostics, 'utf8'), readFileSync(status, 'utf8')];
  } catch {
    throw new Error('Required analysis artifact is missing or unreadable.');
  }
}

function verifySchema(report) {
  let validate;
  try {
    const Ajv = require('ajv');
    const schema = JSON.parse(
      readFileSync(require.resolve('depvitals/schemas/report-v2.schema.json'), 'utf8'),
    );
    if (
      schema.$schema !== 'http://json-schema.org/draft-07/schema#' ||
      schema.properties?.schemaVersion?.const !== 2
    ) {
      throw new Error('Unexpected installed report schema.');
    }
    validate = new Ajv().compile(schema);
  } catch {
    throw new Error('Installed Ajv or DepVitals report v2 schema is missing or invalid.');
  }
  if (!validate(report)) throw new Error('Expected a valid DepVitals v2 report.');
}

function verifyEvidenceOwnership(pkg) {
  const declared = pkg.declaredIn.length > 0;
  const acceptsScriptEvidence =
    pkg.declaredIn.includes('dependencies') || pkg.declaredIn.includes('devDependencies');
  let hasSourceEvidence = false;
  for (const evidence of pkg.evidence) {
    if (evidence.kind === 'source') hasSourceEvidence = true;
    if (evidence.kind === 'script' && !acceptsScriptEvidence) {
      throw new Error('Script evidence requires a dependency or devDependency declaration.');
    }
    if (evidence.kind !== 'config') continue;
    if (!declared) throw new Error('Config evidence requires a package declaration.');
    if (evidence.detector === 'typescript') {
      // Draft 7 has already checked the selector grammar, including scoped names and subpaths.
      const root = evidence.value.split('/', evidence.value.startsWith('@') ? 2 : 1).join('/');
      if (root !== pkg.name) {
        throw new Error('TypeScript config selector disagrees with its owning package.');
      }
    }
  }
  if (!declared && !hasSourceEvidence && !pkg.excluded) {
    throw new Error('Package record requires a declaration, source evidence or exclusion.');
  }
}

function verifyPackageFindings(report) {
  const remaining = new Map(categories.map((key) => [key, new Set(report.findings[key])]));
  for (const [key, names] of remaining) {
    if (names.size !== report.counts[key]) throw new Error('Invalid findings or counts.');
  }

  const excludedNames = new Set(report.scope.ignoreDependencies);
  const seen = new Set();
  for (const pkg of report.packages) {
    if (seen.has(pkg.name)) throw new Error('Duplicate package name.');
    seen.add(pkg.name);
    for (const category of pkg.findings) {
      if (!remaining.get(category).delete(pkg.name)) {
        throw new Error('Package findings disagree with report findings.');
      }
    }

    if (pkg.excluded !== excludedNames.has(pkg.name)) {
      throw new Error('Package exclusion disagrees with report scope.');
    }
    const expectedVisible = pkg.excluded ? [] : pkg.underlyingFindings;
    if (
      pkg.findings.length !== expectedVisible.length ||
      !pkg.findings.every((category) => expectedVisible.includes(category))
    ) {
      throw new Error('Package findings disagree with underlying findings.');
    }
    const expectedUnderlying = [];
    if (pkg.declaredIn.length === 0 && pkg.evidence.some(({ kind }) => kind === 'source')) {
      expectedUnderlying.push('missingDependencies');
    }
    if (pkg.evidence.length === 0) {
      if (pkg.declaredIn.includes('dependencies')) expectedUnderlying.push('unusedDependencies');
      if (pkg.declaredIn.includes('devDependencies'))
        expectedUnderlying.push('unusedDevDependencies');
    }
    if (
      pkg.underlyingFindings.length !== expectedUnderlying.length ||
      !pkg.underlyingFindings.every((category) => expectedUnderlying.includes(category))
    ) {
      throw new Error('Package underlying findings disagree with declarations or evidence.');
    }
    const expectedStatus = pkg.excluded
      ? 'excluded'
      : expectedUnderlying.includes('missingDependencies')
        ? 'missing'
        : expectedUnderlying.length > 0
          ? 'unused'
          : pkg.evidence.length > 0
            ? 'used'
            : 'declared';
    if (pkg.status !== expectedStatus) throw new Error('Package status disagrees with findings.');
    verifyEvidenceOwnership(pkg);
  }

  if ([...excludedNames].some((name) => !seen.has(name))) {
    throw new Error('Report scope excludes an unlisted package.');
  }
  if ([...remaining.values()].some((names) => names.size > 0)) {
    throw new Error('Report findings disagree with package findings.');
  }
}

function verifyDiagnostics(diagnostics) {
  if (diagnostics === undefined) return;
  const { sourceFilesScanned: total, nestedPackageSourceFiles: nested, notices } = diagnostics;
  if (
    nested > total ||
    notices.includes('no-supported-sources') !== (total === 0) ||
    notices.includes('nested-package-inputs') !== nested > 0
  ) {
    throw new Error('Diagnostic notices disagree with source counts.');
  }
  if (
    notices.some(
      (notice, index) =>
        index > 0 && noticeOrder.indexOf(notices[index - 1]) >= noticeOrder.indexOf(notice),
    )
  ) {
    throw new Error('Diagnostic notices are out of order.');
  }
}

function verify(paths) {
  const [stdout, diagnostics, status] = readArtifacts(paths);
  if (status !== '0\n' && status !== '1\n') throw new Error('Invalid scan status.');
  if (status === '1\n' && stdout.length === 0 && diagnostics.trim() !== '') {
    console.error('DepVitals analysis failed. See the diagnostics artifact.');
    return 1;
  }
  if (diagnostics !== '') throw new Error('Unexpected diagnostics for a completed scan.');

  let report;
  try {
    report = JSON.parse(reportDecoder.decode(stdout));
  } catch {
    throw new Error('Expected one complete UTF-8 JSON report.');
  }

  verifySchema(report);
  if (report.mode !== 'scan' || report.tool.version.trim() === '') {
    throw new Error('Expected a DepVitals v2 scan report.');
  }
  verifyPackageFindings(report);
  verifyDiagnostics(report.diagnostics);
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
