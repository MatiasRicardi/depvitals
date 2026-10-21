/**
 * Unit tests for the pure update-check eligibility predicate (Step 64).
 *
 * Every input is injected, so the tests never need real process globals, and the whole behavior
 * matrix of the step is exercised as plain data. The last group of tests proves the negative half
 * of the contract: an ineligible invocation must not reach a network primitive, a cache file or a
 * printed notice, and the module has no capability to do any of those things.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isEligibleUpdateCheck,
  type NotifierCommandKind,
  type NotifierEligibilityInput,
  type NotifierEnv,
} from '../../../src/cli/notifier/eligibility.js';
import { extractModuleSpecifiers } from '../../../src/scanner/moduleSpecifiers.js';

/** A single row of the step's behavior matrix. */
type MatrixRow = {
  readonly label: string;
  readonly input: NotifierEligibilityInput;
  readonly expected: boolean;
};

/** Build an eligible baseline input, overridden per test case. */
function inputFor(overrides: Partial<NotifierEligibilityInput> = {}): NotifierEligibilityInput {
  return {
    env: {},
    stdoutTTY: true,
    stderrTTY: true,
    commandKind: 'scan',
    ...overrides,
  };
}

/** Decide one row of the matrix. */
function decide(overrides: Partial<NotifierEligibilityInput> = {}): boolean {
  return isEligibleUpdateCheck(inputFor(overrides));
}

/** An env map with a single variable set. */
function envWith(key: string, value: string): NotifierEnv {
  return { [key]: value };
}

/** The exact CI variable names the predicate is allowed to consult. */
const CI_VARIABLES: readonly string[] = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'TF_BUILD',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'APPVEYOR',
];

/** Provider-style values that must be read as "this is a CI run". */
const CI_TRUTHY_VALUES: readonly string[] = [
  '1',
  'true',
  'True',
  'TRUE',
  'yes',
  'Yes',
  'on',
  'teamcity',
  'Buildkite',
  'travis',
];

/** Values that explicitly cancel a CI variable, i.e. a normal local developer shell. */
const CI_CANCELLED_VALUES: readonly string[] = ['', '0', 'false', 'False', 'FALSE', 'no', 'off'];

/**
 * Names that merely resemble a CI variable. The predicate matches exact names, so none of them may
 * disable the update check (this is the anti-substring-matching case).
 */
const CI_NEAR_MISSES: readonly string[] = [
  'MY_CI',
  'CI_FLAG',
  'CIX',
  'XCI',
  'ci',
  'Ci',
  'GITLAB',
  'GITLABCI',
  'GITLAB_CI_JOB',
  'GITHUB_ACTION',
  'GITHUB_WORKFLOW',
  'TFBUILD',
  'TF_BUILD_ID_EXTRA',
  'CIRCLE_CI',
  'CIRCLE',
  'TRAVIS_CI',
  'TRAVEL',
  'BUILDKITE_AGENT_NAME',
  'BUILD_ID',
  'JENKINS',
  'JENKINS_HOME_DIR',
  'TEAMCITY',
  'APPVEYOR_REPO',
  'NO_UPDATE_CHECK',
  'UPDATE_CHECK',
];

/** The literal opt-out value and values that must not be treated as an opt-out. */
const OPT_OUT_VALUES: readonly string[] = ['1'];
const NOT_OPTED_OUT_VALUES: readonly string[] = [
  '0',
  '',
  '2',
  '9',
  '01',
  '10',
  '1 ',
  ' 1',
  'true',
  'True',
  'yes',
  'on',
  'y',
  'no',
  'off',
  '0x1',
  'one',
  'DEPVITALS_NO_UPDATE_CHECK',
];

/**
 * The source under test, read as text so the absence of I/O capability can be checked directly.
 * The module has no imports at all, which is the strongest available proof that an ineligible path
 * cannot reach a network client, a cache file or an output stream.
 */
const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../src/cli/notifier/eligibility.ts', import.meta.url)),
  'utf8',
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isEligibleUpdateCheck', () => {
  describe('Step 64 behavior matrix', () => {
    const ROWS: readonly MatrixRow[] = [
      { label: 'Local interactive clean scan', input: inputFor(), expected: true },
      {
        // Findings are an ordinary completed scan; only the exit code differs.
        label: 'Local interactive scan with findings',
        input: inputFor(),
        expected: true,
      },
      {
        label: 'CI=true',
        input: inputFor({ env: envWith('CI', 'true') }),
        expected: false,
      },
      {
        label: 'GITHUB_ACTIONS=true',
        input: inputFor({ env: envWith('GITHUB_ACTIONS', 'true') }),
        expected: false,
      },
      {
        label: 'Opt-out exactly 1',
        input: inputFor({ env: envWith('DEPVITALS_NO_UPDATE_CHECK', '1') }),
        expected: false,
      },
      {
        label: 'stdout piped',
        input: inputFor({ stdoutTTY: false }),
        expected: false,
      },
      {
        label: 'stderr piped',
        input: inputFor({ stderrTTY: false }),
        expected: false,
      },
      { label: '--help', input: inputFor({ commandKind: 'help' }), expected: false },
      { label: '--version', input: inputFor({ commandKind: 'version' }), expected: false },
      { label: 'Argument error', input: inputFor({ commandKind: 'error' }), expected: false },
      {
        label: 'Operational scan failure',
        input: inputFor({ commandKind: 'scan-failure' }),
        expected: false,
      },
    ];

    it.each(ROWS)('$label', ({ label, input, expected }) => {
      expect(isEligibleUpdateCheck(input), label).toBe(expected);
    });
  });

  describe('command kind gate', () => {
    const KINDS: readonly { kind: NotifierCommandKind; expected: boolean }[] = [
      { kind: 'scan', expected: true },
      { kind: 'help', expected: false },
      { kind: 'version', expected: false },
      { kind: 'error', expected: false },
      { kind: 'scan-failure', expected: false },
    ];

    it.each(KINDS)('$kind is ${expected}', ({ kind, expected }) => {
      expect(decide({ commandKind: kind })).toBe(expected);
    });

    it('stays ineligible for an out-of-union kind from an untyped caller', () => {
      const kinds: readonly string[] = [
        'unknown',
        '',
        'SCAN',
        'scan ',
        'clear-cache',
        'scan-failure-x',
      ];

      for (const kind of kinds) {
        expect(decide({ commandKind: kind as unknown as NotifierCommandKind })).toBe(false);
      }
    });
  });

  describe('interactive terminal gate', () => {
    const COMBOS: readonly { stdoutTTY: boolean; stderrTTY: boolean; expected: boolean }[] = [
      { stdoutTTY: true, stderrTTY: true, expected: true },
      { stdoutTTY: true, stderrTTY: false, expected: false },
      { stdoutTTY: false, stderrTTY: true, expected: false },
      { stdoutTTY: false, stderrTTY: false, expected: false },
    ];

    it.each(COMBOS)(
      'stdout $stdoutTTY / stderr $stderrTTY is ${expected}',
      ({ stdoutTTY, stderrTTY, expected }) => {
        expect(decide({ stdoutTTY, stderrTTY })).toBe(expected);
      },
    );

    it('requires both streams even when every other gate passes', () => {
      // Redirected output on either stream suppresses the check even with no CI flag and no
      // opt-out variable at all.
      expect(decide({ stdoutTTY: false, env: {} })).toBe(false);
      expect(decide({ stderrTTY: false, env: {} })).toBe(false);
    });
  });

  describe('CI gate uses the explicit variable list', () => {
    it.each(CI_VARIABLES)('%s blocks the update check when set', (name) => {
      expect(decide({ env: envWith(name, 'true') })).toBe(false);
    });

    it.each(CI_VARIABLES)('%s blocks the update check for provider-style values', (name) => {
      for (const value of CI_TRUTHY_VALUES) {
        expect(decide({ env: envWith(name, value) })).toBe(false);
      }
    });

    it.each(CI_CANCELLED_VALUES)('%s set to a cancelled value stays eligible', (name) => {
      for (const value of CI_CANCELLED_VALUES) {
        expect(decide({ env: envWith(name, value) })).toBe(true);
      }
    });

    it('treats an absent variable list as not CI', () => {
      expect(decide({ env: {} })).toBe(true);
      expect(decide({ env: { SOME_KEY: 'true' } })).toBe(true);
    });

    it.each(CI_NEAR_MISSES)('ignores the near-miss name %s', (name) => {
      expect(decide({ env: envWith(name, 'true') })).toBe(true);
    });

    it('blocks on an unrecognized non-empty value rather than guessing it is local', () => {
      // Providers write identifiers into CI variables (CI=TeamCity), so an unknown value skips the
      // optional network lookup instead of assuming a human terminal.
      expect(decide({ env: envWith('CI', 'TeamCity') })).toBe(false);
      expect(decide({ env: envWith('TF_BUILD', 'True') })).toBe(false);
      expect(decide({ env: envWith('CI', 'undefined') })).toBe(false);
      expect(decide({ env: envWith('CI', 'not-ci-because-nonempty') })).toBe(false);
    });

    it('reads only the declared names out of a large hostile environment', () => {
      const env: NotifierEnv = {
        CI: 'false',
        GITHUB_ACTIONS: 'false',
        GITLAB_CI: 'false',
        TF_BUILD: 'false',
        CIRCLECI: 'false',
        TRAVIS: 'false',
        BUILDKITE: 'false',
        JENKINS_URL: 'false',
        TEAMCITY_VERSION: 'false',
        APPVEYOR: 'false',
        DEPVITALS_DEBUG_UPDATE: 'true',
        HTTP_PROXY: 'http://127.0.0.1:8080',
        NPM_CONFIG_REGISTRY: 'http://localhost:4873',
      };

      expect(decide({ env })).toBe(true);
    });
  });

  describe('opt-out gate honors exactly DEPVITALS_NO_UPDATE_CHECK=1', () => {
    it.each(OPT_OUT_VALUES)('value %s opts out', (value) => {
      expect(decide({ env: envWith('DEPVITALS_NO_UPDATE_CHECK', value) })).toBe(false);
    });

    it.each(NOT_OPTED_OUT_VALUES)('value %s does not opt out', (value) => {
      expect(decide({ env: envWith('DEPVITALS_NO_UPDATE_CHECK', value) })).toBe(true);
    });

    it('ignores a similarly named variable', () => {
      expect(decide({ env: envWith('DEPVITALS_NO_UPDATE', '1') })).toBe(true);
      expect(decide({ env: envWith('NO_UPDATE_CHECK', '1') })).toBe(true);
      expect(decide({ env: envWith('DEPVITALS_UPDATE_CHECK', 'false') })).toBe(true);
    });

    it('keeps the opt-out in force for every stream and CI combination', () => {
      const env: NotifierEnv = { DEPVITALS_NO_UPDATE_CHECK: '1' };

      expect(decide({ env })).toBe(false);
      expect(decide({ env, stdoutTTY: false })).toBe(false);
      expect(decide({ env: { ...env, CI: 'false' } })).toBe(false);
      expect(decide({ env, commandKind: 'help' })).toBe(false);
    });
  });

  describe('gate precedence and independence', () => {
    it('a clean environment does not revive help, version or an error', () => {
      for (const kind of ['help', 'version', 'error', 'scan-failure'] as NotifierCommandKind[]) {
        expect(decide({ commandKind: kind, env: {} })).toBe(false);
      }
    });

    it('a CI flag does not make a piped or non-scan invocation eligible', () => {
      expect(decide({ commandKind: 'help', env: envWith('CI', 'false') })).toBe(false);
      expect(decide({ stdoutTTY: false, env: envWith('CI', 'false') })).toBe(false);
    });

    it('the only eligible combination is a completed scan in two TTYs, without CI or opt-out', () => {
      expect(decide({ env: {} })).toBe(true);
      // Removing any one of the four gates flips the result.
      expect(decide({ commandKind: 'error' })).toBe(false);
      expect(decide({ stderrTTY: false })).toBe(false);
      expect(decide({ env: envWith('CI', '1') })).toBe(false);
      expect(decide({ env: envWith('DEPVITALS_NO_UPDATE_CHECK', '1') })).toBe(false);
    });
  });

  describe('purity and side-effect isolation', () => {
    it('imports nothing at all, so it cannot hold a client, a file handle or a stream', () => {
      expect(extractModuleSpecifiers(MODULE_SOURCE)).toEqual([]);
    });

    it('mentions no network, cache, clock, process or output primitive', () => {
      const forbidden = [
        // Network.
        'fetch(',
        'XMLHttpRequest',
        'node:http',
        'node:https',
        'node:net',
        'node:dns',
        'node:tls',
        'registry.npmjs.org',
        'https://',
        'http://',
        // Cache / filesystem / user directories.
        'node:fs',
        'node:path',
        'node:os',
        'mkdirSync',
        'readFileSync',
        'writeFileSync',
        'homedir',
        'tmpdir',
        'XDG_',
        // Ambient globals, clocks and output.
        'process.',
        'globalThis',
        'console.',
        'Date.now(',
        'new Date(',
        'Math.random(',
        '.write(',
        // Dynamic execution.
        'eval(',
        'new Function(',
        'import(',
        'require(',
        'child_process',
      ];

      const offenders: string[] = [];

      for (const token of forbidden) {
        if (MODULE_SOURCE.includes(token)) {
          offenders.push(token);
        }
      }

      expect(offenders).toEqual([]);
    });

    it('never reaches a network primitive, a cache write or a notice for any matrix row', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        throw new Error('the eligibility predicate must never attempt a lookup');
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const inputs: readonly NotifierEligibilityInput[] = [
        inputFor(),
        inputFor({ stdoutTTY: false }),
        inputFor({ stderrTTY: false }),
        inputFor({ commandKind: 'help' }),
        inputFor({ commandKind: 'version' }),
        inputFor({ commandKind: 'error' }),
        inputFor({ commandKind: 'scan-failure' }),
        inputFor({ env: envWith('CI', 'true') }),
        inputFor({ env: envWith('GITHUB_ACTIONS', 'true') }),
        inputFor({ env: envWith('DEPVITALS_NO_UPDATE_CHECK', '1') }),
      ];

      for (const input of inputs) {
        expect(isEligibleUpdateCheck(input)).toBeTypeOf('boolean');
      }

      expect(fetchSpy.mock.calls).toEqual([]);
      expect(logSpy.mock.calls).toEqual([]);
      expect(errorSpy.mock.calls).toEqual([]);
    });

    it('never mutates its input, not even a frozen environment map', () => {
      const env: NotifierEnv = Object.freeze({
        CI: 'false',
        DEPVITALS_NO_UPDATE_CHECK: '0',
        NPM_CONFIG_REGISTRY: 'http://localhost:4873',
      });
      const input: NotifierEligibilityInput = Object.freeze({
        env,
        stdoutTTY: true,
        stderrTTY: true,
        commandKind: 'scan',
      });

      const snapshot = JSON.stringify(input);

      expect(isEligibleUpdateCheck(input)).toBe(true);
      expect(isEligibleUpdateCheck(input)).toBe(true);
      expect(JSON.stringify(input)).toBe(snapshot);
    });

    it('is deterministic: the same inputs always give the same answer', () => {
      const env: NotifierEnv = { CI: 'false', DEPVITALS_NO_UPDATE_CHECK: '0' };

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(decide({ env })).toBe(true);
        expect(decide({ env: { ...env, CI: 'true' } })).toBe(false);
      }
    });
  });
});
