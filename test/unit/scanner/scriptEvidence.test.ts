import { describe, expect, it } from 'vitest';

import {
  collectPackageScriptUsage,
  findPackageScriptUsage,
} from '../../../src/scanner/scriptUsage.js';
import { hereDocumentCases, hereDocumentDeclaredNames } from '../../helpers/hereDocumentCases.js';
import { opaqueShellCases, opaqueShellDeclaredNames } from '../../helpers/opaqueShellCases.js';
import {
  readMappingCatalog,
  readCollisionSensitiveBinaries,
} from '../../helpers/mappingCatalog.js';

describe('script evidence collection', () => {
  it('retains separate keys, repeated candidates and RFC 6901 pointer escaping', () => {
    const scripts = Object.freeze({ 'z/entry~': 'eslint && eslint', 'a\n😀': 'eslint' });
    expect(collectPackageScriptUsage(scripts, new Set(['eslint']))).toEqual([
      {
        packageName: 'eslint',
        evidence: {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/a\n😀',
          command: 'eslint',
          via: 'direct',
          occurrence: 0,
        },
      },
      {
        packageName: 'eslint',
        evidence: {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/z~1entry~0',
          command: 'eslint',
          via: 'direct',
          occurrence: 0,
        },
      },
      {
        packageName: 'eslint',
        evidence: {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/z~1entry~0',
          command: 'eslint',
          via: 'direct',
          occurrence: 1,
        },
      },
    ]);
    expect(findPackageScriptUsage(scripts, new Set(['eslint']))).toEqual(new Set(['eslint']));
  });

  it('counts undeclared direct, mapped and runner candidates before declaration filtering', () => {
    expect(
      collectPackageScriptUsage(
        { test: 'unknown-command; tsc; npx unknown-package; eslint' },
        new Set(['eslint']),
      ),
    ).toEqual([
      {
        packageName: 'eslint',
        evidence: {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/test',
          command: 'eslint',
          via: 'direct',
          occurrence: 3,
        },
      },
    ]);
  });

  it('does not count manager forms, direct builtins, internal paths or opaque segments as candidates', () => {
    const script =
      'npm run build; pnpm test; fs; ./local; eslint/bin/cli; node $(echo eslint); eslint';
    expect(collectPackageScriptUsage({ test: script }, new Set(['eslint']))).toEqual([
      {
        packageName: 'eslint',
        evidence: {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/test',
          command: 'eslint',
          via: 'direct',
          occurrence: 0,
        },
      },
    ]);
  });

  it('selects collision ownership before emitting a direct or mapped match', () => {
    expect(collectPackageScriptUsage({ run: 'gulp' }, new Set(['gulp', 'gulp-cli']))).toEqual([
      {
        packageName: 'gulp',
        evidence: {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/run',
          command: 'gulp',
          via: 'direct',
          occurrence: 0,
        },
      },
    ]);
    expect(collectPackageScriptUsage({ run: 'gulp' }, new Set(['gulp-cli']))).toEqual([
      {
        packageName: 'gulp-cli',
        evidence: {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/run',
          command: 'gulp',
          via: 'mapping',
          occurrence: 0,
        },
      },
    ]);
  });

  it.each(['npx', 'npm exec', 'pnpm exec', 'pnpm dlx', 'yarn dlx'])(
    'retains the immediate package selector for %s without executable mapping',
    (runner) => {
      const scripts = { run: `MODE=test ${runner} "tsc" --ignored eslint` };
      expect(collectPackageScriptUsage(scripts, new Set(['tsc', 'typescript', 'eslint']))).toEqual([
        {
          packageName: 'tsc',
          evidence: {
            kind: 'script',
            file: 'package.json',
            pointer: '/scripts/run',
            command: 'tsc',
            via: 'runner',
            occurrence: 0,
          },
        },
      ]);
      expect(collectPackageScriptUsage(scripts, new Set(['typescript', 'eslint']))).toEqual([]);
    },
  );

  it('never emits payload or argument text and keeps script-wide ordinals across segments', () => {
    const scripts = {
      test: 'echo "eslint" && node -e "require(\'eslint\')" && MODE=test "eslint" .',
    };
    expect(collectPackageScriptUsage(scripts, new Set(['eslint']))).toEqual([
      {
        packageName: 'eslint',
        evidence: {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/test',
          command: 'eslint',
          via: 'direct',
          occurrence: 2,
        },
      },
    ]);
  });

  it('adds the Node preload ordinal without recognizing nested wrappers', () => {
    const result = collectPackageScriptUsage(
      { test: 'node -r preload && cross-env NODE_ENV=test eslint && eslint' },
      new Set(['node', 'preload', 'cross-env', 'eslint']),
    );
    expect(result).toEqual([
      {
        packageName: 'cross-env',
        evidence: {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/test',
          command: 'cross-env',
          via: 'direct',
          occurrence: 2,
        },
      },
      {
        packageName: 'eslint',
        evidence: {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/test',
          command: 'eslint',
          via: 'direct',
          occurrence: 3,
        },
      },
      {
        packageName: 'node',
        evidence: {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/test',
          command: 'node',
          via: 'direct',
          occurrence: 0,
        },
      },
      {
        packageName: 'preload',
        evidence: {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/test',
          command: 'preload',
          via: 'node-preload',
          occurrence: 1,
        },
      },
    ]);
  });

  it.each(["-r ''", '--import=', '--require --test', '--loader loader', '-p expression'])(
    'discards the entire invalid preload batch for %s and retains outer/next events',
    (suffix) => {
      const result = collectPackageScriptUsage(
        { test: `node -r preload ${suffix} operand && eslint` },
        new Set(['node', 'preload', 'eslint', 'operand']),
      );
      expect(result.map(({ packageName, evidence }) => [packageName, evidence.occurrence])).toEqual(
        [
          ['eslint', 1],
          ['node', 0],
        ],
      );
    },
  );

  it.each(["''", '-'])('stops at operand %s and skips nonexternal module ordinals', (operand) => {
    const result = collectPackageScriptUsage(
      {
        test: `"node" --test -r fs --require=./entry.cjs --import=pkg@1 -r preload ${operand} --import=decoy && eslint`,
      },
      new Set(['node', 'preload', 'decoy', 'eslint']),
    );
    expect(result.map(({ packageName, evidence }) => [packageName, evidence.occurrence])).toEqual([
      ['eslint', 2],
      ['node', 0],
      ['preload', 1],
    ]);
  });

  it('retains the final ordinal of a long supported prefix and skips operand arguments', () => {
    const preloads = 8192;
    const facts = collectPackageScriptUsage(
      {
        check:
          'node ' +
          '-r preload '.repeat(preloads) +
          './entry.cjs ' +
          '--import=decoy '.repeat(preloads),
      },
      new Set(['preload', 'decoy']),
    );
    expect(facts).toHaveLength(preloads);
    expect(facts.at(-1)?.evidence.occurrence).toBe(preloads);
    expect(facts.every(({ packageName }) => packageName === 'preload')).toBe(true);
  });

  it('retains the outer legacy candidate when an empty word precedes node', () => {
    const result = collectPackageScriptUsage(
      { test: `'' node -r preload` },
      new Set(['node', 'preload']),
    );
    expect(result.map(({ packageName }) => packageName)).toEqual(['node']);
  });

  it.each([
    'npx --no-install eslint',
    'npx -p other eslint',
    'npx eslint@latest',
    'pnpm dlx eslint/subpath',
    'echo $(eslint)',
    'eslint > output',
    'eslint "unfinished',
  ])('does not invent credited evidence for unsupported selector/payload %s', (script) => {
    expect(collectPackageScriptUsage({ test: script }, new Set(['eslint']))).toEqual([]);
  });

  it('keeps ordinals around here-documents and opaque regions limited to proven exterior events', () => {
    for (const script of [
      "before-tool; cat <<'EOF'\neslint; eslint\nEOF\neslint",
      'before-tool; echo $(eslint; eslint); eslint',
    ]) {
      expect(collectPackageScriptUsage({ test: script }, new Set(['eslint']))).toEqual([
        {
          packageName: 'eslint',
          evidence: {
            kind: 'script',
            file: 'package.json',
            pointer: '/scripts/test',
            command: 'eslint',
            via: 'direct',
            occurrence: 1,
          },
        },
      ]);
    }
  });

  it('is independent of script and declaration insertion order and preserves case/own keys', () => {
    const scripts = Object.freeze(
      JSON.parse('{"__proto__":"Mixed","constructor":"mixed","":"Mixed"}') as Record<
        string,
        string
      >,
    );
    const expected = collectPackageScriptUsage(scripts, new Set(['Mixed', 'mixed']));
    expect(
      collectPackageScriptUsage(
        Object.fromEntries(Object.entries(scripts).reverse()),
        new Set(['mixed', 'Mixed']),
      ),
    ).toEqual(expected);
    expect(expected.map(({ packageName, evidence }) => [packageName, evidence.pointer])).toEqual([
      ['Mixed', '/scripts/'],
      ['Mixed', '/scripts/__proto__'],
      ['mixed', '/scripts/constructor'],
    ]);
    expect([...findPackageScriptUsage(scripts, new Set(['mixed', 'Mixed']))]).toEqual([
      'Mixed',
      'mixed',
    ]);
  });
});

const catalog = readMappingCatalog();
const collisions = new Set(readCollisionSensitiveBinaries());
describe('complete mapping evidence catalog', () => {
  it.each(catalog)('%s retains its selector and maps to %s', (command, packageName) => {
    const records = collectPackageScriptUsage(
      { catalog: `MODE=1 "${command}" ignored` },
      new Set([packageName]),
    );
    expect(records).toEqual([
      {
        packageName,
        evidence: {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/catalog',
          command,
          via: 'mapping',
          occurrence: 0,
        },
      },
    ]);
  });
  it.each(catalog.filter(([command]) => collisions.has(command)))(
    '%s exact owner wins over %s',
    (command, packageName) => {
      const records = collectPackageScriptUsage(
        { catalog: command },
        new Set([command, packageName]),
      );
      expect(records).toEqual([
        {
          packageName: command,
          evidence: {
            kind: 'script',
            file: 'package.json',
            pointer: '/scripts/catalog',
            command,
            via: 'direct',
            occurrence: 0,
          },
        },
      ]);
    },
  );
});

describe('existing opaque boundaries retain only proven exterior evidence', () => {
  it.each(hereDocumentCases)('here-document: $name', ({ script, expected }) => {
    const records = collectPackageScriptUsage(
      { boundary: script },
      new Set(hereDocumentDeclaredNames),
    );
    expect([...new Set(records.map(({ packageName }) => packageName))]).toEqual(expected);
    expect(
      records.every(
        ({ packageName, evidence }) =>
          evidence.pointer === '/scripts/boundary' &&
          evidence.via === (packageName === 'typescript' ? 'mapping' : 'direct'),
      ),
    ).toBe(true);
  });
  it.each(opaqueShellCases)('opaque region: $name', ({ script, expected }) => {
    const records = collectPackageScriptUsage(
      { boundary: script },
      new Set(opaqueShellDeclaredNames),
    );
    expect([...new Set(records.map(({ packageName }) => packageName))]).toEqual(expected);
    expect(
      records.every(
        ({ packageName, evidence }) =>
          evidence.pointer === '/scripts/boundary' &&
          evidence.via === (packageName === 'typescript' ? 'mapping' : 'direct'),
      ),
    ).toBe(true);
  });
});
