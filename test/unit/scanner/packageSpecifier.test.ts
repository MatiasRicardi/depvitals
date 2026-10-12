import { describe, expect, it } from 'vitest';

import { classifyPackageSpecifier } from '../../../src/scanner/packageSpecifier.js';

describe('classifyPackageSpecifier', () => {
  describe('external packages', () => {
    it('normalizes an unscoped root', () => {
      expect(classifyPackageSpecifier('lodash')).toEqual({
        kind: 'external',
        packageName: 'lodash',
      });
    });

    it('does not lowercase unscoped names', () => {
      expect(classifyPackageSpecifier('React')).toEqual({
        kind: 'external',
        packageName: 'React',
      });
    });

    it('collapses an unscoped subpath to the package root', () => {
      expect(classifyPackageSpecifier('lodash/map/reduce')).toEqual({
        kind: 'external',
        packageName: 'lodash',
      });
      expect(classifyPackageSpecifier('React/jsx-runtime')).toEqual({
        kind: 'external',
        packageName: 'React',
      });
    });

    it('normalizes an unscoped trailing slash', () => {
      expect(classifyPackageSpecifier('lodash/')).toEqual({
        kind: 'external',
        packageName: 'lodash',
      });
    });

    it('normalizes a scoped root', () => {
      expect(classifyPackageSpecifier('@s/pkg')).toEqual({
        kind: 'external',
        packageName: '@s/pkg',
      });
    });

    it('collapses a scoped subpath to the package root', () => {
      expect(classifyPackageSpecifier('@s/pkg/sub/deep')).toEqual({
        kind: 'external',
        packageName: '@s/pkg',
      });
    });

    it('normalizes a scoped trailing slash', () => {
      expect(classifyPackageSpecifier('@s/pkg/')).toEqual({
        kind: 'external',
        packageName: '@s/pkg',
      });
    });

    it('treats a builtin root used as a bare package as external', () => {
      expect(classifyPackageSpecifier('fs/not-real')).toEqual({
        kind: 'external',
        packageName: 'fs',
      });
    });
  });

  describe('node builtins', () => {
    it('recognizes stable builtins in both forms', () => {
      for (const specifier of ['fs', 'path', 'module', 'fs/promises', 'node:fs', 'node:test']) {
        expect(classifyPackageSpecifier(specifier)).toEqual({ kind: 'builtin' });
      }
    });
  });

  describe('internal references', () => {
    it('classifies relative and absolute filesystem references as internal', () => {
      for (const specifier of ['.', '..', './x', '../x', '/foo', '/absolute/path']) {
        expect(classifyPackageSpecifier(specifier)).toEqual({ kind: 'internal' });
      }
    });
  });

  describe('unsupported specifiers', () => {
    it('rejects import aliases', () => {
      expect(classifyPackageSpecifier('#alias')).toEqual({ kind: 'unsupported' });
      expect(classifyPackageSpecifier('#internal/utils')).toEqual({ kind: 'unsupported' });
    });

    it('rejects URI-like schemes', () => {
      for (const specifier of [
        'file:',
        'file:///tmp/x.js',
        'data:text/javascript,console.log(1)',
        'http://example.com',
        'https://example.com',
        'npm:pkg',
        'bun:sqlite',
        'unknown:anything',
      ]) {
        expect(classifyPackageSpecifier(specifier)).toEqual({ kind: 'unsupported' });
      }
    });

    it('rejects Windows-looking paths', () => {
      expect(classifyPackageSpecifier('C:\\foo\\bar')).toEqual({ kind: 'unsupported' });
      expect(classifyPackageSpecifier('C:/foo/bar')).toEqual({ kind: 'unsupported' });
    });

    it('rejects malformed scoped forms', () => {
      for (const specifier of ['@scope', '@scope/', '@/pkg', '@']) {
        expect(classifyPackageSpecifier(specifier)).toEqual({ kind: 'unsupported' });
      }
    });

    it('rejects empty and whitespace-only input', () => {
      expect(classifyPackageSpecifier('')).toEqual({ kind: 'unsupported' });
      expect(classifyPackageSpecifier('   ')).toEqual({ kind: 'unsupported' });
    });

    it('rejects obviously non-package specifiers', () => {
      for (const specifier of [
        'pkg?raw',
        'pkg#fragment',
        'pkg\\sub',
        'pkg name',
        'pkg@version/sub',
      ]) {
        expect(classifyPackageSpecifier(specifier)).toEqual({ kind: 'unsupported' });
      }
    });

    it('rejects an unknown node: specifier', () => {
      expect(classifyPackageSpecifier('node:not-a-real-builtin')).toEqual({
        kind: 'unsupported',
      });
    });
  });
});
