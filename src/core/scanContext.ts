/** Internal per-invocation inputs. No global cache or atomic filesystem snapshot is implied. */
import { readProjectConfigSnapshot, type ProjectConfig } from '../config/readProjectConfig.js';
import {
  collectEslintConfigUsage,
  legacyEslintPrecedenceFromEntries,
  type LegacyEslintPrecedence,
} from '../detectors/eslintManifestConfig.js';
import { collectEslintRcJsonUsageForManifest } from '../detectors/eslintRcJsonConfig.js';
import {
  collectJestConfigUsage,
  hasRootJestConfigEntries,
} from '../detectors/jestManifestConfig.js';
import { loadProjectManifestData, type ProjectManifest } from '../scanner/projectManifest.js';
import { compareEvidence, compareStrings, type ConfigEvidence } from './evidence.js';

export type ScanContext = {
  readonly manifest: ProjectManifest;
  readonly rawManifest: Readonly<Record<string, unknown>>;
  readonly config: ProjectConfig;
  readonly rootEntries: readonly string[];
  readonly eslintPrecedence: LegacyEslintPrecedence;
  readonly jestConfigBarrier: boolean;
  readonly configEvidence: readonly {
    readonly packageName: string;
    readonly evidence: ConfigEvidence;
  }[];
};

/** Validate root/manifest, then strict policy, then collect only the selected detector sources. */
export async function createScanContext(projectRoot: string): Promise<ScanContext> {
  const { manifest, raw } = await loadProjectManifestData(projectRoot);
  const { config, rootEntries } = await readProjectConfigSnapshot(manifest.root);
  const eslintPrecedence = legacyEslintPrecedenceFromEntries(rootEntries);
  const jestConfigBarrier = hasRootJestConfigEntries(rootEntries);
  const configEvidence: { readonly packageName: string; readonly evidence: ConfigEvidence }[] = [];
  if (!eslintPrecedence.hardBarrier) {
    if (eslintPrecedence.legacyRcJsonEntryName !== undefined) {
      const occurrences = await collectEslintRcJsonUsageForManifest(manifest, eslintPrecedence);
      for (const occurrence of occurrences) configEvidence.push(occurrence);
    } else if (!eslintPrecedence.legacyRcByName) {
      const occurrences = collectEslintConfigUsage(
        raw['eslintConfig'],
        manifest.declaredDependencyNames,
      );
      for (const occurrence of occurrences) configEvidence.push(occurrence);
    }
  }
  if (!jestConfigBarrier) {
    const occurrences = collectJestConfigUsage(raw['jest'], manifest.declaredDependencyNames);
    for (const occurrence of occurrences) configEvidence.push(occurrence);
  }
  configEvidence.sort(
    (a, b) =>
      compareStrings(a.packageName, b.packageName) || compareEvidence(a.evidence, b.evidence),
  );
  return {
    manifest,
    rawManifest: raw,
    config,
    rootEntries,
    eslintPrecedence,
    jestConfigBarrier,
    configEvidence,
  };
}
