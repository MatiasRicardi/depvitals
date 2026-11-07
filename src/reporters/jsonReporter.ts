/** Pure versioned JSON projection; internal scan objects never cross the document boundary. */
import type {
  AnalysisFindings,
  DetailedAnalysisResult,
  PackageExplanation,
} from '../core/analyzeProject.js';
import {
  compareStrings,
  DECLARATION_GROUPS,
  FINDING_CATEGORIES,
  sortedUniqueEvidence,
  type Evidence,
  type FindingCategory,
  type PackageFact,
} from '../core/evidence.js';
import { sourceDiscoveryDefaults } from '../scanner/sourceFiles.js';

export type JsonReportInput =
  | { readonly mode: 'scan'; readonly result: DetailedAnalysisResult }
  | { readonly mode: 'explain'; readonly result: PackageExplanation };

export type JsonReport = {
  readonly schemaVersion: 1;
  readonly tool: { readonly name: 'depvitals'; readonly version: string };
  readonly mode: 'scan' | 'explain';
  readonly project: { readonly root: string };
  readonly scope: {
    readonly sourceExtensions: readonly string[];
    readonly excludedDirectories: readonly string[];
    readonly ignorePaths: readonly string[];
    readonly ignoreDependencies: readonly string[];
  };
  readonly findings: AnalysisFindings;
  readonly counts: Readonly<Record<FindingCategory, number>>;
  readonly packages: readonly PackageFact[];
  readonly query: { readonly packageName: string; readonly known: boolean } | null;
};

/** The caller injects actual metadata version; only completed scan/query facts are accepted. */
export function createJsonReport(input: JsonReportInput, version: string): JsonReport {
  const { result } = input;
  const defaults = sourceDiscoveryDefaults();
  const findings = {
    unusedDependencies: names(result.findings.unusedDependencies),
    unusedDevDependencies: names(result.findings.unusedDevDependencies),
    missingDependencies: names(result.findings.missingDependencies),
  };
  return {
    schemaVersion: 1,
    tool: { name: 'depvitals', version },
    mode: input.mode,
    project: { root: result.projectRoot },
    scope: {
      sourceExtensions: defaults.sourceExtensions,
      excludedDirectories: defaults.excludedDirectories,
      ignorePaths: names(result.config.ignorePaths),
      ignoreDependencies: names(result.config.ignoreDependencies),
    },
    findings,
    counts: {
      unusedDependencies: findings.unusedDependencies.length,
      unusedDevDependencies: findings.unusedDevDependencies.length,
      missingDependencies: findings.missingDependencies.length,
    },
    packages: [...result.packages]
      .sort((a, b) => compareStrings(a.name, b.name))
      .map(packageRecord),
    query:
      input.mode === 'explain'
        ? { packageName: input.result.query.packageName, known: input.result.query.known }
        : null,
  };
}

/** Exactly one pretty-printed document and one LF; no process I/O, error envelope or banner. */
export function formatJsonReport(input: JsonReportInput, version: string): string {
  return JSON.stringify(createJsonReport(input, version), null, 2) + '\n';
}

function names(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}
function ordered<T extends string>(values: readonly T[], order: readonly T[]): T[] {
  return [...values].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
function packageRecord(pkg: PackageFact): PackageFact {
  return {
    name: pkg.name,
    status: pkg.status,
    declaredIn: ordered(pkg.declaredIn, DECLARATION_GROUPS),
    excluded: pkg.excluded,
    underlyingFindings: ordered(pkg.underlyingFindings, FINDING_CATEGORIES),
    findings: ordered(pkg.findings, FINDING_CATEGORIES),
    evidence: sortedUniqueEvidence(pkg.evidence).map(evidenceRecord),
  };
}
function evidenceRecord(fact: Evidence): Evidence {
  switch (fact.kind) {
    case 'source':
      return {
        kind: 'source',
        file: fact.file,
        reference: fact.reference,
        specifier: fact.specifier,
        position: {
          offset: fact.position.offset,
          line: fact.position.line,
          column: fact.position.column,
        },
      };
    case 'script':
      return {
        kind: 'script',
        file: fact.file,
        pointer: fact.pointer,
        command: fact.command,
        via: fact.via,
        occurrence: fact.occurrence,
      };
    case 'config':
      return {
        kind: 'config',
        file: fact.file,
        pointer: fact.pointer,
        value: fact.value,
        detector: fact.detector,
      };
  }
}
