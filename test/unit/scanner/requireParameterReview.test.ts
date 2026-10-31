import { spawnSync } from 'node:child_process';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { extractModuleSpecifiers } from '../../../src/scanner/moduleSpecifiers.js';
import { requireParameterReviewCases } from '../../helpers/requireParameterReviewCases.js';

describe('Step 80 review parameter ownership', () => {
  it.each(requireParameterReviewCases)('$name', ({ source, fileName, expected }) => {
    const syntax = fileName.endsWith('.mjs')
      ? undefined
      : ts.transpileModule(source, {
          fileName,
          reportDiagnostics: true,
          compilerOptions: {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            jsx: ts.JsxEmit.React,
          },
        });
    if (syntax !== undefined) {
      expect(syntax.diagnostics).toEqual([]);
    }
    const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], {
      input: syntax?.outputText ?? source,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(checked.error).toBeUndefined();
    expect(checked.status, checked.stderr).toBe(0);
    expect(
      extractModuleSpecifiers(source, { jsx: fileName.endsWith('.tsx') }).map(
        ({ specifier }) => specifier,
      ),
    ).toEqual(expected);
  });
});
