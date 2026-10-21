/**
 * Unit tests for the pure update-notifier version comparison (Step 63).
 *
 * The helper must decide only one thing: is the registry `latest` strictly newer than the installed
 * DepVitals CLI version? Everything unknown resolves to `false`, so a notification can never be
 * produced from an unreliable comparison. These tests are deterministic, offline and need no mocks.
 */

import { describe, expect, it } from 'vitest';

import { isNewerStableVersion } from '../../../src/cli/notifier/versionCompare.js';

/** The behavior matrix defined by Step 63. */
const STEP_MATRIX: readonly { current: string; latest: string; expected: boolean }[] = [
  { current: '0.2.0', latest: '0.2.1', expected: true },
  { current: '0.2.9', latest: '0.2.10', expected: true },
  { current: '0.3.0', latest: '0.2.99', expected: false },
  { current: '1.0.0', latest: '1.0.0', expected: false },
  { current: '0.2.0-rc.1', latest: '0.2.0', expected: false },
  { current: '0.2.0', latest: 'invalid', expected: false },
];

/** Ordering that string comparison would get wrong. */
const NUMERIC_ORDERING: readonly { current: string; latest: string; expected: boolean }[] = [
  { current: '0.2.9', latest: '0.2.10', expected: true },
  { current: '1.9.0', latest: '1.10.0', expected: true },
  { current: '1.0.99', latest: '1.0.100', expected: true },
  { current: '0.99.99', latest: '1.0.0', expected: true },
  { current: '2.0.0', latest: '10.0.0', expected: true },
  { current: '1.10.0', latest: '1.9.0', expected: false },
  { current: '1.0.100', latest: '1.0.99', expected: false },
  { current: '1.0.0', latest: '0.99.99', expected: false },
  { current: '10.0.0', latest: '2.0.0', expected: false },
];

/** Stable pairs that are equal or older, which must never notify. */
const EQUAL_OR_OLDER: readonly { current: string; latest: string }[] = [
  { current: '0.1.0', latest: '0.1.0' },
  { current: '0.2.0', latest: '0.1.9' },
  { current: '0.2.0', latest: '0.0.99' },
  { current: '1.0.0', latest: '0.999.999' },
  { current: '1.2.3', latest: '1.2.2' },
  { current: '9007199254740991.0.0', latest: '9007199254740991.0.0' },
];

/**
 * Inputs the helper must reject on either side: prerelease tags, build metadata, `v` prefixes,
 * partial or extra components, padded numbers, whitespace, non-numeric text and unsafe integers.
 */
const REJECTED_VERSIONS: readonly string[] = [
  // The Step 63 malformed example plus other non-versions.
  'invalid',
  '',
  '   ',
  'latest',
  'next',
  'null',
  'NaN',
  'x',
  '*',
  '1',
  '1.2',
  '1.2.3.4',
  '.1.2',
  '1..2',
  '1.2.',
  '01.2.3',
  '1.02.3',
  '1.2.03',
  'v1.2.3',
  'V1.2.3',
  ' 1.2.3',
  '1.2.3 ',
  '\t1.2.3\n',
  '1. 2.3',
  '1.2.3-alpha',
  '1.2.3-alpha.1',
  '1.2.3-rc.1',
  '1.2.3-0',
  '1.2.3+build.5',
  '1.2.3-alpha+build.5',
  '1.2.x',
  '1.x.3',
  'x.y.z',
  '1.2.3-beta.1+exp.sha.5114f85',
  '-1.2.3',
  '+1.2.3',
  '1.-2.3',
  '1.2.-3',
  '1_2_3',
  '1,2,3',
  '1.2.3\n',
  '1.2.3/next',
  '१.२.३',
  '1e3.0.0',
  '0x1.0.0',
  // Larger than Number.MAX_SAFE_INTEGER: refused instead of silently rounded.
  '9007199254740993.0.0',
  '1.9007199254740993.0',
  '1.2.99999999999999999999',
  '99999999999999999999999999999999.0.0',
];

describe('isNewerStableVersion', () => {
  describe.each(STEP_MATRIX)('Step 63 behavior matrix', ({ current, latest, expected }) => {
    it(`${current} -> ${latest} notifies ${String(expected)}`, () => {
      expect(isNewerStableVersion(current, latest)).toBe(expected);
    });
  });

  describe.each(NUMERIC_ORDERING)('numeric ordering', ({ current, latest, expected }) => {
    it(`${current} -> ${latest} compares numerically as ${String(expected)}`, () => {
      expect(isNewerStableVersion(current, latest)).toBe(expected);
    });
  });

  describe.each(EQUAL_OR_OLDER)('equal or older latest', ({ current, latest }) => {
    it(`${current} -> ${latest} does not notify`, () => {
      expect(isNewerStableVersion(current, latest)).toBe(false);
    });
  });

  describe.each(REJECTED_VERSIONS)('rejected version string %p', (rejected) => {
    it('never notifies when the installed version is rejected', () => {
      expect(isNewerStableVersion(rejected, '1.2.3')).toBe(false);
    });

    it('never notifies when the registry latest is rejected', () => {
      expect(isNewerStableVersion('1.2.3', rejected)).toBe(false);
    });

    it('never notifies when both sides are rejected', () => {
      expect(isNewerStableVersion(rejected, rejected)).toBe(false);
    });
  });

  it('notifies for the largest safe-integer boundary that is still strictly newer', () => {
    expect(isNewerStableVersion('9007199254740991.0.0', '9007199254740991.0.1')).toBe(true);
    expect(isNewerStableVersion('9007199254740991.0.0', '9007199254740992.0.0')).toBe(false);
  });

  it('treats a prerelease installed build as unsupported rather than comparing it', () => {
    // An unpublished prerelease build must stay silent even against a newer stable release.
    expect(isNewerStableVersion('0.2.0-rc.1', '0.3.0')).toBe(false);
    expect(isNewerStableVersion('0.2.0-rc.1', '99.0.0')).toBe(false);
    // ...and a prerelease latest never notifies either.
    expect(isNewerStableVersion('0.2.0', '0.2.1-rc.1')).toBe(false);
  });

  it('is symmetric about equality and never throws on untrusted strings', () => {
    const inputs = [...REJECTED_VERSIONS, '0.0.0', '0.2.0', '1.2.3', '99999.0.0'];

    // No pair may be newer in both directions, and equal pairs are never newer.
    const asymmetric: string[] = [];

    for (const current of inputs) {
      for (const latest of inputs) {
        expect(() => isNewerStableVersion(current, latest)).not.toThrow();

        if (isNewerStableVersion(current, latest) && isNewerStableVersion(latest, current)) {
          asymmetric.push(`${current} <-> ${latest}`);
        }
      }
    }

    expect(asymmetric).toEqual([]);

    for (const current of inputs) {
      expect(isNewerStableVersion(current, current)).toBe(false);
    }
  });

  it('is deterministic and mutates nothing it is given', () => {
    const current = '0.2.9';
    const latest = '0.2.10';

    expect(isNewerStableVersion(current, latest)).toBe(true);
    expect(isNewerStableVersion(current, latest)).toBe(true);
    expect([current, latest]).toEqual(['0.2.9', '0.2.10']);
  });
});
