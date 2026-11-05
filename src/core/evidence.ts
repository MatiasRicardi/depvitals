/** Internal fact model. Collection and classification belong to their owning pipeline stages. */
import * as path from 'node:path';

import type { ModuleSpecifierKind } from '../scanner/moduleSpecifiers.js';
import type { DependencyMap } from '../scanner/projectManifest.js';

export const DECLARATION_GROUPS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
export type DeclarationGroup = (typeof DECLARATION_GROUPS)[number];
export type DeclarationInventory = Readonly<Record<DeclarationGroup, DependencyMap>>;
export const FINDING_CATEGORIES = [
  'unusedDependencies',
  'unusedDevDependencies',
  'missingDependencies',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];
/** Precedence only; this module does not classify packages or infer usage. */
export const PACKAGE_STATUSES = [
  'excluded',
  'missing',
  'unused',
  'used',
  'declared',
  'unknown',
] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

export const SOURCE_REFERENCES = ['import', 'export-from', 'dynamic-import', 'require'] as const;
export type SourceReference = ModuleSpecifierKind;
export type SourceEvidence = {
  kind: 'source';
  file: string;
  reference: SourceReference;
  specifier: string;
  /** Original UTF-16 opening-quote offset (zero-based), line and column (one-based). */
  position: { offset: number; line: number; column: number };
};
export const SCRIPT_VIAS = ['direct', 'mapping', 'runner', 'node-preload'] as const;
export type ScriptEvidence = {
  kind: 'script';
  file: 'package.json';
  pointer: string;
  command: string;
  via: (typeof SCRIPT_VIAS)[number];
  /** Script-wide accepted external candidate ordinal, before declaration filtering. */
  occurrence: number;
};
export const CONFIG_DETECTORS = ['eslint', 'jest'] as const;
export type ConfigEvidence = {
  kind: 'config';
  file: string;
  pointer: string;
  value: string;
  detector: (typeof CONFIG_DETECTORS)[number];
};
export type Evidence = SourceEvidence | ScriptEvidence | ConfigEvidence;
export type PackageFact = {
  name: string;
  status: PackageStatus;
  declaredIn: readonly DeclarationGroup[];
  excluded: boolean;
  underlyingFindings: readonly FindingCategory[];
  findings: readonly FindingCategory[];
  evidence: readonly Evidence[];
};

/** ECMAScript UTF-16 lexicographic order, independent of the host locale. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Own membership only: prototype properties are not declarations. Names remain case-sensitive. */
export function declarationGroupsFor(
  name: string,
  inventory: DeclarationInventory,
): DeclarationGroup[] {
  return DECLARATION_GROUPS.filter((group) => Object.hasOwn(inventory[group], name));
}

/** Lexical display only. The caller owns filesystem validation and symlink policy. */
export function evidencePath(
  root: string,
  file: string,
  paths: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'> = path,
): string {
  if (!paths.isAbsolute(root) || !paths.isAbsolute(file)) {
    throw new Error('Evidence paths require an absolute project root and file');
  }
  const relative = paths.relative(root, file);
  const components = relative.split(paths.sep);
  if (
    paths.isAbsolute(relative) ||
    components.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Evidence file must be inside the project root');
  }
  return components.join('/');
}

/** RFC 6901 data pointer, not a URI fragment. An empty token is significant. */
export function jsonPointer(...tokens: readonly string[]): string {
  return tokens.map((token) => '/' + token.replaceAll('~', '~0').replaceAll('/', '~1')).join('');
}

const EVIDENCE_KINDS = ['source', 'script', 'config'] as const;

export function compareEvidence(a: Evidence, b: Evidence): number {
  const common =
    EVIDENCE_KINDS.indexOf(a.kind) - EVIDENCE_KINDS.indexOf(b.kind) ||
    compareStrings(a.file, b.file);
  if (common !== 0) return common;
  if (a.kind === 'source' && b.kind === 'source') {
    return (
      a.position.offset - b.position.offset ||
      SOURCE_REFERENCES.indexOf(a.reference) - SOURCE_REFERENCES.indexOf(b.reference) ||
      compareStrings(a.specifier, b.specifier) ||
      a.position.line - b.position.line ||
      a.position.column - b.position.column
    );
  }
  if (a.kind === 'script' && b.kind === 'script') {
    return (
      compareStrings(a.pointer, b.pointer) ||
      a.occurrence - b.occurrence ||
      SCRIPT_VIAS.indexOf(a.via) - SCRIPT_VIAS.indexOf(b.via) ||
      compareStrings(a.command, b.command)
    );
  }
  if (a.kind === 'config' && b.kind === 'config') {
    return (
      compareStrings(a.pointer, b.pointer) ||
      CONFIG_DETECTORS.indexOf(a.detector) - CONFIG_DETECTORS.indexOf(b.detector) ||
      compareStrings(a.value, b.value)
    );
  }
  return 0;
}

/** Explicit tuples make exact identity independent of object property insertion order. */
export function evidenceIdentity(evidence: Evidence): string {
  switch (evidence.kind) {
    case 'source':
      return JSON.stringify([
        evidence.kind,
        evidence.file,
        evidence.reference,
        evidence.specifier,
        evidence.position.offset,
        evidence.position.line,
        evidence.position.column,
      ]);
    case 'script':
      return JSON.stringify([
        evidence.kind,
        evidence.file,
        evidence.pointer,
        evidence.command,
        evidence.via,
        evidence.occurrence,
      ]);
    case 'config':
      return JSON.stringify([
        evidence.kind,
        evidence.file,
        evidence.pointer,
        evidence.value,
        evidence.detector,
      ]);
  }
}

export function sortedUniqueEvidence(records: readonly Evidence[]): Evidence[] {
  const unique = new Map<string, Evidence>();
  for (const record of records) unique.set(evidenceIdentity(record), record);
  return [...unique.values()].sort(compareEvidence);
}
