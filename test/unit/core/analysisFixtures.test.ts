/**
 * End-to-end regression coverage for the `v0.1.0` dependency-analysis pipeline.
 *
 * Every scenario below is a committed fixture directory under `test/fixtures/analysis/`. The test
 * runs the full pipeline against real files on disk - manifest loading, source discovery, specifier
 * extraction, package classification and dependency analysis - and asserts the complete
 * {@link AnalysisResult}.
 *
 * The goal is integration confidence: the same behaviors are already covered in isolation by unit
 * tests (specifier extraction, source discovery, manifest parsing), but here they are verified
 * together through the exact contract the CLI depends on. Each fixture demonstrates one or a small
 * group of behaviors, and the fixtures are sized so that an incorrect lexical match or a source
 * discovery regression would change the golden result and fail the test.
 */

import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeProject, type AnalysisResult } from '../../../src/core/analyzeProject.js';
import { formatTerminalReport } from '../../../src/reporters/terminalReporter.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/analysis/', import.meta.url));

/** Absolute path to a committed analysis fixture. */
function fixturePath(name: string): string {
  return resolve(join(FIXTURES, name));
}

/** The complete expected result for a fixture, with a platform-aware absolute project root. */
function expectedResult(name: string, result: Omit<AnalysisResult, 'projectRoot'>): AnalysisResult {
  return {
    projectRoot: fixturePath(name),
    ...result,
  };
}

/**
 * The seven required Step 15 scenarios. Each entry asserts the complete structured result so a
 * change in any of the three arrays (or the project root) fails the build.
 */
const SCENARIOS: {
  name: string;
  result: Omit<AnalysisResult, 'projectRoot'>;
  note: string;
}[] = [
  {
    name: 'script-opaque-grouped',
    result: { unusedDependencies: [], unusedDevDependencies: ['eslint'], missingDependencies: [] },
    note: 'Unsupported substitutions stay opaque; grouping and comments preserve exterior commands, while unproven boundaries retain no remainder evidence.',
  },
  {
    name: 'script-opaque-comment',
    result: { unusedDependencies: [], unusedDevDependencies: ['eslint'], missingDependencies: [] },
    note: 'Unsupported substitutions stay opaque; grouping and comments preserve exterior commands, while unproven boundaries retain no remainder evidence.',
  },
  {
    name: 'script-opaque-undeclared',
    result: { unusedDependencies: [], unusedDevDependencies: [], missingDependencies: [] },
    note: 'Unsupported substitutions stay opaque; grouping and comments preserve exterior commands, while unproven boundaries retain no remainder evidence.',
  },
  {
    name: 'script-opaque-unknown',
    result: {
      unusedDependencies: [],
      unusedDevDependencies: ['eslint', 'prettier'],
      missingDependencies: [],
    },
    note: 'Unsupported substitutions stay opaque; grouping and comments preserve exterior commands, while unproven boundaries retain no remainder evidence.',
  },
  {
    name: 'script-heredoc-declared',
    result: { unusedDependencies: [], unusedDevDependencies: ['eslint'], missingDependencies: [] },
    note: 'Here-document payloads are opaque; only a proven literal boundary restores command evidence, and scripts never create missing findings.',
  },
  {
    name: 'script-heredoc-undeclared',
    result: { unusedDependencies: [], unusedDevDependencies: [], missingDependencies: [] },
    note: 'Here-document payloads are opaque; only a proven literal boundary restores command evidence, and scripts never create missing findings.',
  },
  {
    name: 'script-heredoc-unsupported',
    result: {
      unusedDependencies: [],
      unusedDevDependencies: ['eslint', 'prettier'],
      missingDependencies: [],
    },
    note: 'Here-document payloads are opaque; only a proven literal boundary restores command evidence, and scripts never create missing findings.',
  },
  {
    name: 'script-heredoc-unterminated',
    result: {
      unusedDependencies: [],
      unusedDevDependencies: ['eslint', 'prettier'],
      missingDependencies: [],
    },
    note: 'Here-document payloads are opaque; only a proven literal boundary restores command evidence, and scripts never create missing findings.',
  },
  ...(['declared', 'undeclared'] as const).map((mode) => ({
    name: `require-arrow-method-parameters-${mode}`,
    result: {
      unusedDependencies:
        mode === 'declared'
          ? ['fake-arrow', 'fake-class', 'fake-default', 'fake-inherited', 'fake-method']
          : [],
      unusedDevDependencies: [],
      missingDependencies:
        mode === 'undeclared'
          ? [
              'real-after',
              'real-asi',
              'real-before',
              'real-default',
              'real-inside',
              'real-key',
              'real-key-control',
              'real-method-name',
              'real-module',
            ]
          : [],
    },
    note: 'Arrow and method parameters own only their initializers and bodies; computed keys, imports, method names and exterior calls remain evidence.',
  })),
  ...(['declared', 'undeclared'] as const).map((mode) => ({
    name: `require-signature-review-${mode}`,
    result: {
      unusedDependencies: mode === 'declared' ? ['fake-bound', 'fake-newline', 'fake-regex'] : [],
      unusedDevDependencies: [],
      missingDependencies:
        mode === 'undeclared'
          ? ['real-after', 'real-first', 'real-generic', 'real-implementation']
          : [],
    },
    note: 'Bodyless signatures restore global scope; generic default type names never become bindings, while real require parameters still bind.',
  })),
  ...(['declared', 'undeclared'] as const).map((mode) => ({
    name: `require-function-parameters-${mode}`,
    result: {
      unusedDependencies:
        mode === 'declared' ? ['fake-body', 'fake-default', 'fake-inherited', 'fake-template'] : [],
      unusedDevDependencies: [],
      missingDependencies:
        mode === 'undeclared'
          ? [
              'real-after',
              'real-before',
              'real-default',
              'real-key',
              'real-loader',
              'real-module',
              'real-type',
            ]
          : [],
    },
    note: 'Function parameter bindings suppress only their owned requires, including earlier defaults and nested bodies; keys/types and real module imports stay evidence.',
  })),
  ...(['declared', 'undeclared'] as const).map((mode) => ({
    name: `dynamic-import-options-${mode}`,
    result: {
      unusedDependencies:
        mode === 'declared'
          ? [
              'fake-array',
              'fake-attribute',
              'fake-computed',
              'fake-extra',
              'fake-require',
              'fake-text',
              'fake-variable',
              'json',
            ]
          : [],
      unusedDevDependencies: [],
      missingDependencies:
        mode === 'undeclared'
          ? [
              'real-after',
              'real-array',
              'real-assert',
              'real-extra',
              'real-nested',
              'real-outer',
              'real-with',
            ]
          : [],
    },
    note: 'Balanced dynamic import options retain literal sources and independent nested calls, never attribute strings.',
  })),
  ...(['declared', 'undeclared'] as const).map((mode) => ({
    name: `literal-trailing-comma-${mode}`,
    result: {
      unusedDependencies:
        mode === 'declared'
          ? ['fake-concat', 'fake-import-options', 'fake-member', 'fake-options', 'fake-template']
          : [],
      unusedDevDependencies: [],
      missingDependencies:
        mode === 'undeclared'
          ? ['real-after', 'real-import', 'real-nested', 'real-require', 'real-trivia']
          : [],
    },
    note: 'Sole literals with trailing commas count as source evidence; unsupported outer calls retain nested real calls only.',
  })),
  ...(['declared', 'undeclared'] as const).map((mode) => ({
    name: `contextual-type-${mode}`,
    result: {
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: mode === 'undeclared' ? ['contextual-default', 'contextual-named'] : [],
    },
    note: 'Contextual type/as/from imports preserve both used and missing dependency evidence.',
  })),
  ...(['declared', 'undeclared'] as const).map((mode) => ({
    name: `import-property-${mode}`,
    result: {
      unusedDependencies:
        mode === 'declared' ? ['fake-class', 'fake-destructuring', 'fake-object'] : [],
      unusedDevDependencies: [],
      missingDependencies: ['real-package'],
    },
    note: 'Import property names neither invent missing evidence nor suppress unused declarations.',
  })),
  {
    name: 'esm',
    result: {
      unusedDependencies: ['unused-esm-dep'],
      unusedDevDependencies: [],
      missingDependencies: ['dynamic-pkg', 'reexport-pkg', 'side-effect-pkg'],
    },
    note:
      'ESM: static import, side-effect import, re-export, literal dynamic import, Node builtin and ' +
      'relative import, plus an unused declared dependency and missing undeclared ones.',
  },
  {
    name: 'commonjs',
    result: {
      unusedDependencies: ['unused-cjs-dep'],
      unusedDevDependencies: [],
      missingDependencies: ['missing-cjs'],
    },
    note:
      'CommonJS: a real require() usage, an unused declared dependency, a missing dependency, and ' +
      'fake require() calls in comments, strings, templates, regex, non-literal and property calls.',
  },
  {
    name: 'typescript',
    result: {
      unusedDependencies: ['unused-ts-dep'],
      unusedDevDependencies: [],
      missingDependencies: [],
    },
    note:
      'TypeScript: import type, normal import, export-from, .tsx discovery and a scoped subpath, ' +
      'with one unused declared dependency and no missing dependencies.',
  },
  {
    name: 'scripts-only-devtools',
    result: {
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    },
    note:
      'Scripts-only dev tools: eslint, prettier and vite are declared but never imported from ' +
      'source, yet must not be reported as unused because scripts reference them.',
  },
  {
    name: 'declarations',
    result: {
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    },
    note:
      'Declaration files: a .d.ts importing an external package counts as usage and suppresses the ' +
      'unused finding for that package.',
  },
  {
    name: 'ignored-directories',
    result: {
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    },
    note:
      'Ignored/generated directories: package-like imports inside node_modules, dist, coverage and ' +
      'build must never affect the result.',
  },
  {
    name: 'peer-optional',
    result: {
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    },
    note:
      'Peer/optional dependencies: packages declared only as peer or optional and imported from ' +
      'source are never reported as missing nor as unused.',
  },
  {
    name: 'builtins',
    result: {
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    },
    note:
      'Node builtins: `node:fs`, the bare `fs` form and `path` are recognized as builtins and ' +
      'never reported as missing external packages, and with nothing else declared the result is ' +
      'clean.',
  },
  {
    name: 'typed-modules',
    result: {
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: ['missing-in-mts'],
    },
    note:
      '.mts/.cts end-to-end: a real import inside a `.mts` file marks `zod` used and reports ' +
      '`missing-in-mts` as missing, and a real import inside a `.cts` file marks `legacy-helper` ' +
      'used, proving both module-source extensions are analyzed.',
  },
];

describe('analyzeProject end-to-end fixtures', () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      it(`produces the complete golden result (${scenario.note})`, async () => {
        const result = await analyzeProject(fixturePath(scenario.name));

        expect(result).toEqual(expectedResult(scenario.name, scenario.result));
      });
    });
  }
});

describe('analyzeProject end-to-end terminal reports', () => {
  it('renders unused and missing dependencies for the ESM fixture', async () => {
    const result = await analyzeProject(fixturePath('esm'));

    expect(formatTerminalReport(result)).toBe(
      'DepVitals\n\n' +
        'Unused dependencies (1)\n' +
        '  unused-esm-dep\n\n' +
        'Missing dependencies (3)\n' +
        '  dynamic-pkg\n' +
        '  reexport-pkg\n' +
        '  side-effect-pkg\n',
    );
  });

  it('renders a clean report for a project with no findings', async () => {
    const result = await analyzeProject(fixturePath('scripts-only-devtools'));

    expect(formatTerminalReport(result)).toBe('DepVitals\n\nNo dependency issues found.\n');
  });
});
