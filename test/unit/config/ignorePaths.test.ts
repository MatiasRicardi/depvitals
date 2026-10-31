import * as fs from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { matchesIgnoredPath, normalizeIgnorePaths } from '../../../src/config/ignorePaths.js';
import { ProjectConfigError } from '../../../src/config/readProjectConfig.js';

vi.mock('node:fs/promises', () => {
  const forbidden = (): never => {
    throw new Error('Path policy must not access the filesystem');
  };
  return { lstat: vi.fn(forbidden), readdir: vi.fn(forbidden), readFile: vi.fn(forbidden) };
});
const CONFIG = '/selected-project/depvitals.config.json';
afterEach(() => {
  expect(fs.lstat).not.toHaveBeenCalled();
  expect(fs.readdir).not.toHaveBeenCalled();
  expect(fs.readFile).not.toHaveBeenCalled();
});

const accepted: readonly (readonly [string, string])[] = [
  ['./src/generated/', 'src/generated'],
  ['src\\generated', 'src/generated'],
  ['.\\src\\generated\\', 'src/generated'],
  ['src//generated///', 'src/generated'],
  ['././src/./generated/.', 'src/generated'],
  ['src/./generated/', 'src/generated'],
  ['src\\.//generated\\file.ts', 'src/generated/file.ts'],
  ['src/file.ts', 'src/file.ts'],
  ['examples', 'examples'],
  ['not-installed/no-file.js', 'not-installed/no-file.js'],
  ['some folder/other file.ts', 'some folder/other file.ts'],
  ['src / file.js', 'src / file.js'],
  ['$HOME/cache', '$HOME/cache'],
  ['~/cache', '~/cache'],
  ['~', '~'],
  ['$', '$'],
  ['.hidden/file.js', '.hidden/file.js'],
  ['.../file.js', '.../file.js'],
  ['..hidden/file.js', '..hidden/file.js'],
  ['Src/Generated', 'Src/Generated'],
  ['c/src', 'c/src'],
  ['node_modules/x', 'node_modules/x'],
  ['%2e%2e/literal.js', '%2e%2e/literal.js'],
  ['src/#literal.js', 'src/#literal.js'],
  ['package.json', 'package.json'],
  ['.eslintrc.json', '.eslintrc.json'],
  ['eslint.config.js', 'eslint.config.js'],
  ['δοκιμή/例子.js', 'δοκιμή/例子.js'],
];

describe('literal ignorePaths normalization', () => {
  it.each(accepted)('normalizes %j to %j without I/O', (rule, expected) => {
    expect(normalizeIgnorePaths([rule], CONFIG)).toEqual([expected]);
  });

  it('deduplicates normalized entries, sorts deterministically, and preserves input/case', () => {
    const input = Object.freeze([
      'z/path',
      './src/generated/',
      'src\\generated',
      'src//generated/.',
      'A',
      'a',
      'src',
      'z/path',
    ]);
    expect(normalizeIgnorePaths(input, CONFIG)).toEqual([
      'A',
      'a',
      'src',
      'src/generated',
      'z/path',
    ]);
    expect(input).toEqual([
      'z/path',
      './src/generated/',
      'src\\generated',
      'src//generated/.',
      'A',
      'a',
      'src',
      'z/path',
    ]);
    expect(normalizeIgnorePaths([...input].reverse(), CONFIG)).toEqual(
      normalizeIgnorePaths(input, CONFIG),
    );
  });

  it('accepts empty arrays and returns readonly frozen rules', () => {
    expect(normalizeIgnorePaths([], CONFIG)).toEqual([]);
    expect(Object.isFrozen(normalizeIgnorePaths(['src'], CONFIG))).toBe(true);
  });

  it('reports the original raw index and rejects the whole batch without partial rules', () => {
    // Earlier rules collapse to the same literal, so a shifted or deduplicated index would mislead.
    const raw = Object.freeze(['./src\\generated/', 'src//generated/.', '../outside', 'src/other']);
    let failure: unknown;
    try {
      normalizeIgnorePaths(raw, CONFIG);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProjectConfigError);
    if (!(failure instanceof ProjectConfigError)) {
      throw new Error('Expected path configuration error');
    }
    expect(failure.message).toContain('ignorePaths[2]');
    expect(failure.message).toContain(CONFIG);
  });

  it('is idempotent for rules already normalized by this policy', () => {
    const once = normalizeIgnorePaths(['./Src\\gen/', 'src//gen/.', 'a b/c', './a b/c'], CONFIG);
    expect(once).toEqual(['Src/gen', 'a b/c', 'src/gen']);
    expect(normalizeIgnorePaths(once, CONFIG)).toEqual(once);
  });

  const invalid: readonly (readonly [string, string])[] = [
    ['/', 'relative'],
    ['\\', 'relative'],
    ['/root', 'relative'],
    ['//server/share', 'relative'],
    ['\\root', 'relative'],
    ['\\\\server\\share', 'relative'],
    ['C:\\absolute', 'relative'],
    ['C:/absolute', 'relative'],
    ['C:relative', 'relative'],
    ['c:relative', 'relative'],
    ['C:', 'relative'],
    ['\\\\?\\C:\\absolute', 'relative'],
    ['\\\\.\\device', 'relative'],
    ['/\\mixed', 'relative'],
    ['../outside', '..'],
    ['..', '..'],
    ['src/../inside', '..'],
    ['src\\..\\inside', '..'],
    ['src//..//inside', '..'],
    ['./../outside', '..'],
    ['', 'root'],
    ['.', 'root'],
    ['./', 'root'],
    ['.\\', 'root'],
    ['././', 'root'],
    ['src:name', 'colon'],
    ['./C:relative', 'colon'],
    ['src/C:/file', 'colon'],
    ['file:src', 'colon'],
    ['https://host/src', 'colon'],
    [' src', 'whitespace'],
    ['src ', 'whitespace'],
    ['\tsrc', 'whitespace'],
    ['src\n', 'whitespace'],
    ['\u00a0src', 'whitespace'],
    ['src\ufeff', 'whitespace'],
    ['src/zero\u0000.js', 'control'],
    ['src/line\n.js', 'control'],
    ['src/tab\t.js', 'control'],
    ['src/del\u007f.js', 'control'],
    ['src/c1\u0085.js', 'control'],
    ...['*', '?', '[', ']', '{', '}', '!'].map(
      (character) => [`src/${character}file`, 'unsupported pattern'] as const,
    ),
    ['src/**', 'unsupported pattern'],
    ['src/[ab]', 'unsupported pattern'],
    ['!src', 'unsupported pattern'],
    ['${HOME}/src', 'unsupported pattern'],
  ];
  it.each(invalid)('rejects %j with %s diagnostics and original field/index', (rule, reason) => {
    let failure: unknown;
    try {
      normalizeIgnorePaths(['valid-first', rule], CONFIG);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProjectConfigError);
    if (!(failure instanceof ProjectConfigError))
      throw new Error('Expected path configuration error');
    expect(failure.code).toBe('invalid-shape');
    expect(failure.message).toContain(CONFIG);
    expect(failure.message).toContain('ignorePaths[1]');
    expect(failure.message).toContain(reason);
  });
});

describe('literal segment matching, independent of extensions', () => {
  const rules = normalizeIgnorePaths(['./src\\gen/', './readme.txt', '$HOME', '~/cache'], CONFIG);
  it.each([
    'src/gen',
    'src/gen/file.ts',
    'src/gen/deep/file.js',
    'src/gen/package.json',
    'readme.txt',
    '$HOME',
    '$HOME/file.js',
    '~/cache/file.js',
  ])('matches exact paths and full descendant segments: %s', (path) => {
    expect(matchesIgnoredPath(path, rules)).toBe(true);
  });
  it.each([
    'src/generator',
    'src/gen-extra/file.js',
    'src/gen.ts',
    'src/Gen/file.ts',
    'Src/gen/file.ts',
    'other/src/gen/file.ts',
    'readme.txt.bak',
    'readme.TXT',
    'HOME/file.js',
    'cache/file.js',
    '/home/user/cache/file.js',
  ])('retains neighbors, different casing and unexpanded names: %s', (path) => {
    expect(matchesIgnoredPath(path, rules)).toBe(false);
  });
  it('does not reinterpret literal backslashes, dots or encoded text in canonical filenames', () => {
    const literalRules = normalizeIgnorePaths(['src/gen', '%2e%2e'], CONFIG);
    expect(matchesIgnoredPath('src\\gen/file.ts', literalRules)).toBe(false);
    expect(matchesIgnoredPath('src/gen\\file.ts', literalRules)).toBe(false);
    expect(matchesIgnoredPath('./src/gen/file.ts', literalRules)).toBe(false);
    expect(matchesIgnoredPath('../outside.js', literalRules)).toBe(false);
    expect(matchesIgnoredPath('%2e%2e/literal.js', literalRules)).toBe(true);
  });
  it('matches no path with empty rules', () => {
    expect(matchesIgnoredPath('src/file.js', [])).toBe(false);
  });
});
