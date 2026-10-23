import { describe, expect, it } from 'vitest';

import type { AnalysisResult } from '../../../src/core/analyzeProject.js';
import {
  formatTerminalReport,
  hasDependencyIssues,
} from '../../../src/reporters/terminalReporter.js';

/** Fixed project root used by every case: the reporter must never render it. */
const PROJECT_ROOT = '/home/user/projects/demo';

/**
 * Build an `AnalysisResult` with only the requested findings populated. The remaining categories
 * stay empty, which keeps every assertion about section omission explicit in the test body.
 */
function analysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    projectRoot: PROJECT_ROOT,
    unusedDependencies: [],
    unusedDevDependencies: [],
    missingDependencies: [],
    ...overrides,
  };
}

describe('formatTerminalReport', () => {
  it('renders the exact clean report when every findings category is empty', () => {
    const output = formatTerminalReport(analysis());

    expect(output).toBe('DepVitals\n\nNo dependency issues found.\n');
  });

  it('renders only the unused dependencies section', () => {
    const output = formatTerminalReport(analysis({ unusedDependencies: ['lodash', 'moment'] }));

    expect(output).toBe(
      ['DepVitals', '', 'Unused dependencies (2)', '  lodash', '  moment', ''].join('\n'),
    );
  });

  it('renders only the unused devDependencies section', () => {
    const output = formatTerminalReport(analysis({ unusedDevDependencies: ['@acme/test-utils'] }));

    expect(output).toBe(
      ['DepVitals', '', 'Unused devDependencies (1)', '  @acme/test-utils', ''].join('\n'),
    );
  });

  it('renders only the missing dependencies section', () => {
    const output = formatTerminalReport(analysis({ missingDependencies: ['zod'] }));

    expect(output).toBe(['DepVitals', '', 'Missing dependencies (1)', '  zod', ''].join('\n'));
  });

  it('renders every section in the fixed order', () => {
    const output = formatTerminalReport(
      analysis({
        unusedDependencies: ['lodash', 'moment'],
        unusedDevDependencies: ['eslint'],
        missingDependencies: ['zod'],
      }),
    );

    expect(output).toBe(
      [
        'DepVitals',
        '',
        'Unused dependencies (2)',
        '  lodash',
        '  moment',
        '',
        'Unused devDependencies (1)',
        '  eslint',
        '',
        'Missing dependencies (1)',
        '  zod',
        '',
      ].join('\n'),
    );
  });

  it('keeps the section order stable regardless of which categories are populated', () => {
    const output = formatTerminalReport(
      analysis({
        unusedDependencies: ['lodash'],
        missingDependencies: ['zod'],
      }),
    );

    const unusedIndex = output.indexOf('Unused dependencies');
    const missingIndex = output.indexOf('Missing dependencies');

    expect(unusedIndex).toBeGreaterThan(-1);
    expect(missingIndex).toBeGreaterThan(unusedIndex);
  });

  it('omits empty sections entirely and never prints a zero count', () => {
    const output = formatTerminalReport(analysis({ missingDependencies: ['zod'] }));

    expect(output).not.toContain('Unused dependencies');
    expect(output).not.toContain('Unused devDependencies');
    expect(output).not.toContain('(0)');
  });

  it('sorts package names alphabetically even when the result supplies them unsorted', () => {
    const output = formatTerminalReport(
      analysis({
        unusedDependencies: ['zod', 'lodash', '@scope/beta', 'Array', 'moment'],
        unusedDevDependencies: ['vitest', 'eslint'],
        missingDependencies: ['react', 'antd'],
      }),
    );

    expect(output).toBe(
      [
        'DepVitals',
        '',
        'Unused dependencies (5)',
        '  @scope/beta',
        '  Array',
        '  lodash',
        '  moment',
        '  zod',
        '',
        'Unused devDependencies (2)',
        '  eslint',
        '  vitest',
        '',
        'Missing dependencies (2)',
        '  antd',
        '  react',
        '',
      ].join('\n'),
    );
  });

  it('counts exactly the package names it renders', () => {
    const output = formatTerminalReport(
      analysis({
        unusedDependencies: ['lodash', 'moment'],
        unusedDevDependencies: ['eslint'],
        missingDependencies: ['zod'],
      }),
    );

    const renderedNames = output.split('\n').filter((line) => line.startsWith('  ')).length;
    const counted = [...output.matchAll(/\((\d+)\)/gu)].reduce(
      (total, match) => total + Number(match[1]),
      0,
    );

    expect(renderedNames).toBe(4);
    expect(counted).toBe(renderedNames);
  });

  it('separates the heading and the sections with exactly one blank line', () => {
    const output = formatTerminalReport(
      analysis({
        unusedDependencies: ['lodash'],
        unusedDevDependencies: ['eslint'],
        missingDependencies: ['zod'],
      }),
    );

    expect(output.startsWith('DepVitals\n\nUnused dependencies (1)\n')).toBe(true);
    // Three blank lines: the one after the heading plus the two boundaries between three sections.
    expect(output.match(/\n\n/gu)).toHaveLength(3);
    expect(output).not.toContain('\n\n\n');
  });

  it('ends with exactly one newline and never with a trailing blank section', () => {
    const cases: readonly AnalysisResult[] = [
      analysis(),
      analysis({ unusedDependencies: ['lodash'] }),
      analysis({
        unusedDependencies: ['lodash'],
        unusedDevDependencies: ['eslint'],
        missingDependencies: ['zod'],
      }),
    ];

    for (const result of cases) {
      const output = formatTerminalReport(result);

      expect(output.endsWith('\n')).toBe(true);
      expect(output.endsWith('\n\n')).toBe(false);
      expect(output.endsWith('\n  \n')).toBe(false);
    }
  });

  it('prints package names verbatim without normalizing them', () => {
    const output = formatTerminalReport(
      analysis({ unusedDependencies: ['@scope/pkg/sub', 'lodash/fp'] }),
    );

    expect(output).toBe(
      ['DepVitals', '', 'Unused dependencies (2)', '  @scope/pkg/sub', '  lodash/fp', ''].join(
        '\n',
      ),
    );
  });

  it('escapes control characters so a hostile name cannot clear the terminal', () => {
    // An ESC decoded from a source string such as `import("\x1b[2J")` must never reach the
    // terminal unchanged; it is rendered as the literal, inert `\u001b` sequence instead.
    const hostile = `lodash${String.fromCharCode(27)}[2J`;
    const output = formatTerminalReport(analysis({ unusedDependencies: [hostile] }));

    expect(output).not.toContain(String.fromCharCode(27));
    expect(output).toContain('  lodash\\u001b[2J');
  });

  it('does not deduplicate names, which stays an analyzer concern', () => {
    const output = formatTerminalReport(analysis({ unusedDependencies: ['lodash', 'lodash'] }));

    expect(output).toBe(
      ['DepVitals', '', 'Unused dependencies (2)', '  lodash', '  lodash', ''].join('\n'),
    );
  });

  it('never renders the project root and ignores it entirely', () => {
    const findings = { unusedDependencies: ['lodash'], missingDependencies: ['zod'] };

    const output = formatTerminalReport(analysis({ ...findings, projectRoot: PROJECT_ROOT }));
    const other = formatTerminalReport(analysis({ ...findings, projectRoot: 'C:\\repos\\demo' }));

    expect(output).not.toContain(PROJECT_ROOT);
    expect(output).not.toContain('C:\\repos\\demo');
    expect(output).toBe(
      [
        'DepVitals',
        '',
        'Unused dependencies (1)',
        '  lodash',
        '',
        'Missing dependencies (1)',
        '  zod',
        '',
      ].join('\n'),
    );
    expect(other).toBe(output);
  });

  it('does not mutate the received result or its arrays', () => {
    const unusedDependencies = ['zod', 'lodash'];
    const unusedDevDependencies = ['vitest', 'eslint'];
    const missingDependencies = ['react', 'antd'];

    const result = analysis({
      unusedDependencies,
      unusedDevDependencies,
      missingDependencies,
    });

    const snapshot = structuredClone({
      unusedDependencies,
      unusedDevDependencies,
      missingDependencies,
    });

    formatTerminalReport(result);

    expect(unusedDependencies).toStrictEqual(snapshot.unusedDependencies);
    expect(unusedDevDependencies).toStrictEqual(snapshot.unusedDevDependencies);
    expect(missingDependencies).toStrictEqual(snapshot.missingDependencies);
    expect(result.unusedDependencies).toBe(unusedDependencies);
  });
});

describe('hasDependencyIssues', () => {
  it('returns false when every findings category is empty', () => {
    expect(hasDependencyIssues(analysis())).toBe(false);
  });

  it('returns true when unused dependencies are present', () => {
    expect(hasDependencyIssues(analysis({ unusedDependencies: ['lodash'] }))).toBe(true);
  });

  it('returns true when unused devDependencies are present', () => {
    expect(hasDependencyIssues(analysis({ unusedDevDependencies: ['eslint'] }))).toBe(true);
  });

  it('returns true when missing dependencies are present', () => {
    expect(hasDependencyIssues(analysis({ missingDependencies: ['zod'] }))).toBe(true);
  });
});
