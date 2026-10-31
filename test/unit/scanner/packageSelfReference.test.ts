import { describe, expect, it } from 'vitest';

import {
  classifyPackageSpecifier,
  createPackageSelfReferenceScope,
  isPackageSelfReference,
} from '../../../src/scanner/packageSpecifier.js';

describe('bounded exact package self references', () => {
  it.each(['self-pkg', '@scope/self-pkg', 'MixedCase'])('matches exact exports for %s', (name) => {
    const scope = createPackageSelfReferenceScope({
      name,
      exports: {
        '.': './index.js',
        './feature': './feature.js',
        './deep/feature': './dist/deep.js',
      },
    });
    for (const suffix of ['', '/feature', '/deep/feature']) {
      expect(isPackageSelfReference(`${name}${suffix}`, scope)).toBe(true);
    }
    for (const specifier of [
      `${name}/missing-key`,
      `${name}-extra/feature`,
      `${name}/feature/extra`,
      `${name}/Feature`,
      `${name}/feature/`,
      `${name}/./feature`,
      `${name}/a/../feature`,
      `${name}//feature`,
      `${name}/feature?query`,
      `${name}/feature#hash`,
      `${name}/%66eature`,
      ` ${name}`,
      `${name} `,
    ])
      expect(isPackageSelfReference(specifier, scope)).toBe(false);
  });

  it('a direct string only enables the root reference', () => {
    const scope = createPackageSelfReferenceScope({
      name: 'self-pkg',
      exports: './not-installed.js',
    });
    expect(isPackageSelfReference('self-pkg', scope)).toBe(true);
    expect(isPackageSelfReference('self-pkg/feature', scope)).toBe(false);
  });

  it('a subpath export does not imply a root export', () => {
    const scope = createPackageSelfReferenceScope({
      name: 'self-pkg',
      exports: { './feature': './feature.js' },
    });
    expect(isPackageSelfReference('self-pkg/feature', scope)).toBe(true);
    expect(isPackageSelfReference('self-pkg', scope)).toBe(false);
  });

  it.each([
    undefined,
    null,
    1,
    [],
    {},
    { default: './index.js' },
    ['./index.js'],
    { '.': null },
    { '.': ['./index.js'] },
    { '.': { import: './index.js' } },
    { './*': './dist/*.js' },
    { '.': './index.js', import: './index.js' },
    { '.': './index.js', './feature': { default: './feature.js' } },
  ])('does not guess unsupported exports: %j', (exports) => {
    const scope = createPackageSelfReferenceScope({ name: 'self-pkg', exports });
    expect(isPackageSelfReference('self-pkg', scope)).toBe(false);
    expect(isPackageSelfReference('self-pkg/feature', scope)).toBe(false);
  });

  it.each([
    '',
    '.',
    './',
    '../outside.js',
    './a/../outside.js',
    '././index.js',
    './a//index.js',
    './node_modules/pkg/index.js',
    './NODE_MODULES/pkg/index.js',
    './a/node_modules/pkg.js',
    './%2e%2e/outside.js',
    './a%2fb.js',
    './a%5cb.js',
    './*.js',
    './x?.js',
    './x#hash.js',
    '/absolute.js',
    'file:./index.js',
    'https://example.test/index.js',
    './file:target.js',
    'C:\\index.js',
    '.\\index.js',
    './a\\b.js',
    './nul\u0000.js',
    './line\n.js',
  ])('rejects an unsafe or unsupported lexical target: %j', (target) => {
    expect(
      isPackageSelfReference(
        'self-pkg',
        createPackageSelfReferenceScope({ name: 'self-pkg', exports: target }),
      ),
    ).toBe(false);
    expect(
      isPackageSelfReference(
        'self-pkg/feature',
        createPackageSelfReferenceScope({ name: 'self-pkg', exports: { './feature': target } }),
      ),
    ).toBe(false);
  });

  it.each([
    'feature',
    './',
    './a/../feature',
    './node_modules/feature',
    './a//feature',
    './*',
    './feature?x',
    './feature#x',
    './%66eature',
    './a\\feature',
  ])('rejects unsupported export keys: %j', (key) => {
    const scope = createPackageSelfReferenceScope({
      name: 'self-pkg',
      exports: { [key]: './index.js' },
    });
    expect(isPackageSelfReference('self-pkg/feature', scope)).toBe(false);
    expect(scope.exportedSubpaths.size).toBe(0);
  });

  it.each([undefined, null, '', 1, {}, 'another-pkg', 'self-pkg/feature', 'self-pkg*'])(
    'does not match a missing, mismatched or unsupported name: %j',
    (name) => {
      expect(
        isPackageSelfReference(
          'self-pkg',
          createPackageSelfReferenceScope({ name, exports: './index.js' }),
        ),
      ).toBe(false);
    },
  );

  it('keeps present nameless/no-exports scopes distinct from an absent scope', () => {
    const nameless = createPackageSelfReferenceScope({ exports: './index.js' });
    const withoutExports = createPackageSelfReferenceScope({ name: 'self-pkg' });
    expect(nameless).toBeDefined();
    expect(withoutExports).toBeDefined();
    expect(nameless.name).toBeUndefined();
    for (const scope of [undefined, nameless, withoutExports]) {
      expect(isPackageSelfReference('self-pkg', scope)).toBe(false);
    }
  });

  it('does not change ordinary classification or mutate input metadata', () => {
    const exports = Object.freeze({ './feature': './does-not-need-to-exist.js' });
    const metadata = Object.freeze({ name: 'self-pkg', exports });
    const scope = createPackageSelfReferenceScope(metadata);
    expect(isPackageSelfReference('self-pkg/feature', scope)).toBe(true);
    expect(classifyPackageSpecifier('self-pkg/feature')).toEqual({
      kind: 'external',
      packageName: 'self-pkg',
    });
    expect(metadata.exports).toBe(exports);
    expect(metadata).toEqual({
      name: 'self-pkg',
      exports: { './feature': './does-not-need-to-exist.js' },
    });
    expect(
      isPackageSelfReference(
        'self-pkg/feature',
        createPackageSelfReferenceScope({ name: 'SELF-PKG', exports }),
      ),
    ).toBe(false);
  });
});

it('distinguishes literal path segments from traversal and node_modules lookalikes', () => {
  const scope = createPackageSelfReferenceScope({
    name: 'self-pkg',
    exports: { './feature': './node_modules-extra/.hidden.js', './deep': './dist/...name.js' },
  });
  expect(isPackageSelfReference('self-pkg/feature', scope)).toBe(true);
  expect(isPackageSelfReference('self-pkg/deep', scope)).toBe(true);
});

it('preserves builtin priority while allowing same-name external subpaths', () => {
  const scope = createPackageSelfReferenceScope({
    name: 'fs',
    exports: { '.': './index.js', './feature': './feature.js' },
  });
  expect(isPackageSelfReference('fs', scope)).toBe(false);
  expect(isPackageSelfReference('node:fs', scope)).toBe(false);
  expect(isPackageSelfReference('fs/feature', scope)).toBe(true);
});
