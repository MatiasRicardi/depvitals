import { describe, expect, it } from 'vitest';

import { extractModuleSpecifiers } from '../../../src/scanner/moduleSpecifiers.js';

/** A string-shaped input counts indexed reads, so growth checks do not depend on wall time. */
function scanWithReadCount(source: string): number {
  let reads = 0;
  const methods = {
    length: source.length,
    codePointAt: source.codePointAt.bind(source),
    indexOf: source.indexOf.bind(source),
    slice: source.slice.bind(source),
    startsWith: source.startsWith.bind(source),
  };
  const measured = new Proxy(methods, {
    get(target, key, receiver): unknown {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads++;
        return source[Number(key)];
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  expect(extractModuleSpecifiers(measured as unknown as string)).toEqual([
    { specifier: 'outside', kind: 'require' },
  ]);
  return reads;
}

describe('expression type-argument probe growth', () => {
  it.each([' < ', ' < x && '])('keeps failed comparison probes linear with %s', (separator) => {
    const measure = (size: number): number => {
      const body = Array.from({ length: size }, (_, index) => `v${String(index)}`).join(separator);
      const source = `const f = require => ${body}; require('outside');`;
      return scanWithReadCount(source) / source.length;
    };
    const small = measure(160);
    const large = measure(640);
    expect(large).toBeLessThan(small * 1.5);
  });
});
