/** Exact identifier validation; analysis applies validated names only to final findings. */
import { ProjectConfigError } from './projectConfigError.js';

const COMPONENT = '[A-Za-z0-9][A-Za-z0-9._-]*';
const IDENTIFIER = new RegExp(`^(?:${COMPONENT}|@${COMPONENT}/${COMPONENT})$`, 'u');

/**
 * Preserve exact case and spelling; validate whole entries before sorting/deduplicating.
 * This bounded grammar is independent of source subpath normalization and builtin classification.
 * configPath is diagnostic context only. No inventory, filesystem or registry is consulted.
 */
export function normalizeIgnoreDependencies(
  rawNames: readonly string[],
  configPath: string,
): readonly string[] {
  for (const [index, name] of rawNames.entries()) {
    if (name.length > 214 || IDENTIFIER.exec(name)?.[0] !== name) {
      throw new ProjectConfigError(
        `${configPath} field ignoreDependencies[${String(index)}] must be an exact package root (name or @scope/name), at most 214 characters; components must start with ASCII alphanumeric and contain only ASCII alphanumeric, '.', '_' or '-'`,
        'invalid-shape',
      );
    }
  }
  return Object.freeze([...new Set(rawNames)].sort());
}
