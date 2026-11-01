import * as fs from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeIgnoreDependencies } from '../../../src/config/ignoreDependencies.js';
import { ProjectConfigError } from '../../../src/config/readProjectConfig.js';
import { classifyPackageSpecifier } from '../../../src/scanner/packageSpecifier.js';

vi.mock('node:fs/promises', () => {
  const forbidden = (): never => {
    throw new Error('Identifier validation must not access files');
  };
  return { lstat: vi.fn(forbidden), readdir: vi.fn(forbidden), readFile: vi.fn(forbidden) };
});
const CONFIG = '/selected-project/depvitals.config.json';
afterEach(() => {
  expect(fs.lstat).not.toHaveBeenCalled();
  expect(fs.readdir).not.toHaveBeenCalled();
  expect(fs.readFile).not.toHaveBeenCalled();
});

const accepted = [
  'foo',
  '@scope/foo',
  'LegacyPkg',
  '@Legacy/Some-Adapter',
  'fs',
  '0',
  '9pkg',
  'pkg.name',
  'pkg_name',
  'pkg_',
  '@scope_/pkg_',
  'pkg-name',
  'pkg.',
  'pkg-',
  '@scope_/pkg',
  'not-declared',
  'constructor',
  'a'.repeat(214),
  '@s/' + 'a'.repeat(211),
];
const rejected = [
  '',
  ' ',
  '_',
  '_pkg',
  '.pkg',
  '-pkg',
  '!pkg',
  'foo/sub',
  '@scope/pkg/subpath',
  'foo/',
  '@scope/pkg/',
  'pkg@1',
  'foo@latest',
  '*',
  '?',
  '[pkg]',
  '{pkg}',
  './foo',
  '../foo',
  '/foo',
  'C:foo',
  'C:\\foo',
  'foo\\sub',
  'node:fs',
  'https://example.com/pkg',
  'npm:pkg',
  ' foo',
  'foo ',
  'foo bar',
  'foo\n',
  'foo\r',
  'foo\t',
  'foo\u0000',
  'foo\u007f',
  'foo\u0085',
  'foo\u00a0',
  '@scope',
  '@scope/',
  '@/pkg',
  '@/',
  '@@scope/pkg',
  '@scope/@pkg',
  '@scope//pkg',
  '@_scope/pkg',
  '@scope/.pkg',
  '@scope/-pkg',
  'café',
  '例子',
  '$foo',
  '~foo',
  'foo#bar',
  'foo%20bar',
  'foo+bar',
  'a'.repeat(215),
  '@s/' + 'a'.repeat(212),
];

describe('exact ignoreDependencies identifiers', () => {
  it.each(accepted)('preserves valid identity %j without I/O', (name) => {
    expect(normalizeIgnoreDependencies([name], CONFIG)).toEqual([name]);
  });
  it.each(rejected)('rejects the whole batch for %j with original index', (name) => {
    try {
      normalizeIgnoreDependencies(['foo', 'foo', name, 'after'], CONFIG);
      throw new Error('Expected invalid identifier');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectConfigError);
      expect(error).toMatchObject({ code: 'invalid-shape' });
      expect((error as Error).message).toContain(CONFIG);
      expect((error as Error).message).toContain('ignoreDependencies[2]');
    }
  });
  it('sorts and deduplicates exact identities without changing case, scope or input', () => {
    const names = Object.freeze(['foo', 'Foo', '@scope/foo', '@other/foo', 'foo-extra', 'foo']);
    const result = normalizeIgnoreDependencies(names, CONFIG);
    expect(result).toEqual(['@other/foo', '@scope/foo', 'Foo', 'foo', 'foo-extra']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(names).toEqual(['foo', 'Foo', '@scope/foo', '@other/foo', 'foo-extra', 'foo']);
    expect(normalizeIgnoreDependencies([...names].reverse(), CONFIG)).toEqual(result);
    expect(normalizeIgnoreDependencies(result, CONFIG)).toEqual(result);
    expect(normalizeIgnoreDependencies([], CONFIG)).toEqual([]);
  });
  it('does not reuse source builtin or subpath classification as identifier validation', () => {
    expect(classifyPackageSpecifier('fs')).toEqual({ kind: 'builtin' });
    expect(normalizeIgnoreDependencies(['fs'], CONFIG)).toEqual(['fs']);
    expect(classifyPackageSpecifier('foo/sub')).toEqual({ kind: 'external', packageName: 'foo' });
    expect(() => normalizeIgnoreDependencies(['foo/sub'], CONFIG)).toThrow(ProjectConfigError);
  });
});
