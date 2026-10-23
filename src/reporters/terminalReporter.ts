/**
 * Deterministic terminal reporter.
 *
 * Renders an {@link AnalysisResult} as plain terminal text and nothing else: the module performs no
 * process I/O, never imports `node:process`, never writes to a stream, never assigns an exit code,
 * and never reads the filesystem. It is a pure `AnalysisResult -> string` transformation, so the
 * exact output is fully testable and can be reused by any future presentation layer.
 *
 * The `v0.1.0` output is intentionally plain. It contains exactly:
 * - the `DepVitals` heading;
 * - one section per non-empty findings category, in a fixed order;
 * - the clean-project message when there are no findings at all.
 *
 * It deliberately does not contain colors, symbols, spinners, tables, terminal-width detection,
 * links, prompts, source locations, advice, remediation commands, dependency counts, project paths
 * or any summary footer. Those belong to later releases, if they are added at all.
 *
 * Output contract:
 * - sections appear in the order `Unused dependencies`, `Unused devDependencies`,
 *   `Missing dependencies`;
 * - empty sections are omitted entirely (a `Category (0)` heading is never printed);
 * - package names are sorted alphabetically inside each section and counted exactly as rendered;
 * - every package name is indented with exactly two spaces;
 * - exactly one blank line follows the heading and separates consecutive sections;
 * - no blank line follows the last section;
 * - the returned string ends with exactly one `\n`, always LF regardless of platform.
 *
 * The reporter guarantees its own ordering by sorting a copy of every findings array with a
 * private codepoint comparator: it never relies on the caller having sorted the input, never mutates
 * the received arrays, and never uses locale-sensitive comparison. Deduplication stays the analyzer's
 * responsibility, so a duplicated name inside a category would be rendered twice by design.
 */

import type { AnalysisResult } from '../core/analyzeProject.js';

/** Heading printed as the first line of every report. */
const HEADER = 'DepVitals';

/** Exact report returned when the analysis contains no findings at all. */
const CLEAN_REPORT = `${HEADER}\n\nNo dependency issues found.\n`;

/** A rendered findings category: its heading and the package names it lists. */
type Section = {
  heading: string;
  names: readonly string[];
};

/**
 * Whether the analysis produced at least one unused or missing dependency finding.
 *
 * Pure and side-effect free. It reports nothing about process exit codes: deciding when a CLI run
 * should fail belongs to the caller that owns the process.
 */
export function hasDependencyIssues(result: AnalysisResult): boolean {
  return (
    result.unusedDependencies.length > 0 ||
    result.unusedDevDependencies.length > 0 ||
    result.missingDependencies.length > 0
  );
}

/**
 * Render the complete terminal report for `result`, including its single trailing newline.
 *
 * @param result - The structured analysis produced by the dependency analyzer.
 * @returns The full terminal text: the clean message, or the heading followed by the non-empty
 *   findings sections in deterministic order.
 */
export function formatTerminalReport(result: AnalysisResult): string {
  if (!hasDependencyIssues(result)) {
    return CLEAN_REPORT;
  }

  const sections = findingsSections(result).filter((section) => section.names.length > 0);

  return `${HEADER}\n\n${sections.map(renderSection).join('\n\n')}\n`;
}

/**
 * The findings categories in their fixed rendering order. Keeping the order here means the section
 * sequence can never depend on the shape or key order of the incoming result.
 */
function findingsSections(result: AnalysisResult): readonly Section[] {
  return [
    { heading: 'Unused dependencies', names: result.unusedDependencies },
    { heading: 'Unused devDependencies', names: result.unusedDevDependencies },
    { heading: 'Missing dependencies', names: result.missingDependencies },
  ];
}

/**
 * Render one non-empty section: a heading carrying the number of rendered packages, followed by one
 * two-space-indented line per package name.
 *
 * The count is taken from the sorted copy, so it always matches the lines printed below it.
 */
function renderSection(section: Section): string {
  const names = [...section.names].sort(compareNames);

  const count = String(names.length);

  // Package names come from target-project source, so a hostile name may carry a terminal control
  // sequence (for example an ESC decoded from `"\x1b[2J"`). Escape C0/C1 control codes and DEL as
  // `\uXXXX` before rendering, so the report can never alter the user's display.
  return [
    `${section.heading} (${count})`,
    ...names.map((name) => `  ${escapeControlCharacters(name)}`),
  ].join('\n');
}
/**
 * Escape C0/C1 control characters and DEL as `\uXXXX` so a package name extracted from target
 * source can never carry a terminal control sequence (such as an ESC from `"\x1b[2J"`) into the
 * rendered report. Printable characters pass through unchanged.
 *
 * The scan is written as explicit code points instead of a control-character regex range so the
 * ESLint `no-control-regex` rule stays meaningful.
 */
function escapeControlCharacters(value: string): string {
  let out = '';

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    out += value[index] ?? '';
  }

  return out;
}

/**
 * Locale-independent lexicographic (codepoint) ordering, matching the comparator convention already
 * used by the analyzer. `localeCompare` is deliberately avoided: its result depends on the runtime
 * locale, which would break deterministic terminal output across machines.
 */
function compareNames(a: string, b: string): number {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
}
