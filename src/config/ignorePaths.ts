/** Literal path policy shared by configuration validation and source discovery. */
import { ProjectConfigError } from './projectConfigError.js';

/**
 * Validate every raw rule before returning a normalized, sorted, deduplicated snapshot. Both slash
 * spellings are config separators on every host. No rule destination is probed or resolved.
 * configPath is diagnostic context supplied by the caller, not a file to read here.
 */
export function normalizeIgnorePaths(
  rawRules: readonly string[],
  configPath: string,
): readonly string[] {
  const normalized = rawRules.map((rule, index) => {
    const fail = (reason: string): never => {
      throw new ProjectConfigError(
        `${configPath} field ignorePaths[${String(index)}] ${reason}`,
        'invalid-shape',
      );
    };
    // Check the original spelling: normalization must never hide a rooted or drive-relative rule.
    if (rule.startsWith('/') || rule.startsWith('\\') || /^[A-Za-z]:/.test(rule)) {
      fail(
        'must be project-relative; absolute, rooted, UNC and drive-relative paths are unsupported',
      );
    }
    if (rule !== rule.trim()) fail('must not have leading or trailing whitespace');
    if (rule.includes(':')) fail('must not contain a colon');
    if (/\p{Cc}/u.test(rule)) fail('must not contain a control character');
    if (['*', '?', '[', ']', '{', '}', '!'].some((character) => rule.includes(character))) {
      fail('contains unsupported pattern characters; use a literal file or subtree path');
    }
    const segments = rule.replaceAll('\\', '/').split('/');
    if (segments.includes('..')) fail('must not contain a .. traversal segment');
    const result = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
    if (result.length === 0) fail('must name a nonempty path, not the project root');
    // Dot/separator removal can expose whitespace that was interior in the raw spelling.
    if (result !== result.trim())
      fail('must not have leading or trailing whitespace after normalization');
    return result;
  });
  return Object.freeze([...new Set(normalized)].sort());
}

/**
 * Compare a canonical '/'-separated project-relative discovery path against validated rules.
 * The caller converts native discovery separators; this matcher does not resolve or normalize
 * candidate filenames. Matching is case-sensitive, extension-independent and segment-bounded.
 */
export function matchesIgnoredPath(
  projectRelativePath: string,
  normalizedRules: readonly string[],
): boolean {
  return normalizedRules.some(
    (rule) => projectRelativePath === rule || projectRelativePath.startsWith(`${rule}/`),
  );
}
