/** Offline development receipt generator. Run after a clean build with node --expose-gc. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { normalizeIgnoreDependencies } from '../dist/config/ignoreDependencies.js';
import { normalizeIgnorePaths } from '../dist/config/ignorePaths.js';
import { analyzeProject } from '../dist/core/analyzeProject.js';
import { findEslintManifestUsage } from '../dist/detectors/eslintManifestConfig.js';
import { findEslintRcJsonUsage } from '../dist/detectors/eslintRcJsonConfig.js';
import { findJestManifestUsage } from '../dist/detectors/jestManifestConfig.js';
import { extractModuleSpecifiers } from '../dist/scanner/moduleSpecifiers.js';
import { discoverSourceFiles } from '../dist/scanner/sourceFiles.js';
import { identifyBuild, identifyInputs, verifyMeasuredArchive } from './measurementIdentity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WARMUPS = 3;
const REPEATS = 7;
assert.equal(
  typeof globalThis.gc,
  'function',
  'Run node --expose-gc scripts/measure-scanning.mjs <npm-pack.json>',
);
assert(
  process.argv[2],
  'Supply the JSON output of npm pack --json --ignore-scripts after a clean build',
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function summarize(samples) {
  const times = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  return {
    medianMs: times[Math.floor(times.length / 2)],
    minMs: times[0],
    maxMs: times.at(-1),
    samples,
  };
}
async function measure(run, verify) {
  for (let i = 0; i < WARMUPS; i++) verify(await run());
  const samples = [];
  for (let i = 0; i < REPEATS; i++) {
    globalThis.gc();
    const before = process.memoryUsage();
    const start = performance.now();
    const result = await run();
    const ms = performance.now() - start;
    const after = process.memoryUsage();
    verify(result); // Assertions and explicit GC are outside the timed interval.
    globalThis.gc();
    samples.push({
      ms,
      heapBeforeBytes: before.heapUsed,
      heapAfterBytes: after.heapUsed,
      heapDeltaBytes: after.heapUsed - before.heapUsed,
      heapAfterGcBytes: process.memoryUsage().heapUsed,
      rssBeforeBytes: before.rss,
      rssAfterBytes: after.rss,
    });
  }
  return summarize(samples);
}
async function scan(root, options) {
  const configUsedNames = new Set([
    ...(await findEslintManifestUsage(root)),
    ...(await findEslintRcJsonUsage(root)),
    ...(await findJestManifestUsage(root)),
  ]);
  const { projectRoot, ...findings } = await analyzeProject(root, { ...options, configUsedNames });
  assert.equal(projectRoot, root);
  return findings;
}

const corpusPath = join(ROOT, 'test/fixtures/measurement-corpus/corpus.json');
const manifest = readJson(join(ROOT, 'package.json'));
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
assert.equal(Object.keys(manifest.optionalDependencies ?? {}).length, 0);
const build = identifyBuild(ROOT);
const packPath = resolve(process.argv[2]);
const artifact = verifyMeasuredArchive(packPath, ROOT, build);
const receipt = {
  methodology: {
    warmups: WARMUPS,
    repeats: REPEATS,
    gcBeforeAndAfterEachSample: true,
    scanBoundary:
      'In-process static detector collection plus analyzeProject; excludes process startup, config-file loading, report rendering, setup, expected-finding comparisons and explicit GC; includes a root-identity sanity check.',
    memoryBoundary:
      'Whole-process observations at sample boundaries, not allocation totals or in-scan peaks. Heap deltas may be negative due to automatic GC. maxRSS is cumulative for this generator, including setup.',
    noTimingThreshold: true,
  },
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    kernel: release(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
  },
  identity: {
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10000,
    }).trim(),
    packageVersion: manifest.version,
    packageManager: manifest.packageManager,
    lockSha256: hash(readFileSync(join(ROOT, 'pnpm-lock.yaml'))),
    helperSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    identityHelperSha256: hash(readFileSync(new URL('./measurementIdentity.mjs', import.meta.url))),
    corpusManifestSha256: hash(readFileSync(corpusPath)),
    buildSha256: hash(JSON.stringify(build)),
    build,
  },
  corpus: [],
  properties: [],
  pruning: [],
  artifact: undefined,
};
for (const entry of readJson(corpusPath)) {
  const root = realpathSync(resolve(ROOT, entry.root));
  const options = {
    ignorePaths: normalizeIgnorePaths(entry.ignorePaths, 'measurement scope'),
    ignoreDependencies: normalizeIgnoreDependencies(entry.ignoreDependencies, 'measurement scope'),
  };
  const sources = await discoverSourceFiles(root, options);
  const before = identifyInputs(root, sources);
  const observation = await measure(
    () => scan(root, options),
    (actual) => assert.deepEqual(actual, entry.expected),
  );
  assert.deepEqual(identifyInputs(root, await discoverSourceFiles(root, options)), before);
  receipt.corpus.push({
    id: entry.id,
    root: entry.root,
    scope: options,
    scopeExceptionCount: options.ignorePaths.length + options.ignoreDependencies.length,
    sourceFileCount: sources.length,
    sourceBytes: sources.reduce((sum, path) => sum + readFileSync(path).length, 0),
    inputs: before,
    expected: entry.expected,
    observation,
  });
  console.error(`Measured corpus: ${entry.id}`);
}
for (const count of [500, 1000, 2000, 4000, 8000]) {
  for (const property of ['import', 'other']) {
    const source = `({${property}:1});`.repeat(count) + "require('real');";
    const observation = await measure(
      () => extractModuleSpecifiers(source).map(({ specifier }) => specifier),
      (actual) => assert.deepEqual(actual, ['real']),
    );
    receipt.properties.push({
      count,
      property,
      bytes: Buffer.byteLength(source),
      sourceSha256: hash(source),
      observation,
    });
  }
  console.error(`Measured property/control: ${count}`);
}
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'depvitals-measure-pruning-')));
try {
  for (const count of [0, 1000, 5000]) {
    const root = join(scratch, String(count));
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), '{"dependencies":{"prune-live":"*"}}');
    writeFileSync(join(root, 'index.cjs'), "require('prune-live');");
    const missing = [];
    for (let i = 0; i < count; i++) {
      const name = `prune-tree-${String(i).padStart(5, '0')}`;
      missing.push(name);
      const directory = join(root, 'generated', String(Math.floor(i / 100)));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${i}.cjs`), `require('${name}');`);
    }
    const allSources = await discoverSourceFiles(root);
    const before = identifyInputs(root, allSources);
    for (const pruned of [false, true]) {
      const options = { ignorePaths: pruned ? ['generated'] : [] };
      const expected = {
        unusedDependencies: [],
        unusedDevDependencies: [],
        missingDependencies: pruned ? [] : missing,
      };
      const selected = await discoverSourceFiles(root, options);
      assert.equal(selected.length, pruned ? 1 : count + 1);
      const observation = await measure(
        () => scan(root, options),
        (actual) => assert.deepEqual(actual, expected),
      );
      receipt.pruning.push({
        generatedFiles: count,
        pruned,
        selectedSourceFiles: selected.length,
        generator:
          "100 files/directory; require('prune-tree-<five-digit-index>'); retained index requires declared prune-live",
        inputSha256: before.sha256,
        findingsSha256: hash(JSON.stringify(expected)),
        missingCount: expected.missingDependencies.length,
        observation,
      });
    }
    assert.deepEqual(identifyInputs(root, await discoverSourceFiles(root)), before);
    console.error(`Measured tree/pruning: ${count}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
assert.deepEqual(
  verifyMeasuredArchive(packPath, ROOT, build),
  artifact,
  'Archive changed during measurement',
);
receipt.artifact = artifact;
assert.deepEqual(identifyBuild(ROOT), build, 'Build changed during measurement');
receipt.processMaxRssKiB = process.resourceUsage().maxRSS;
console.log(JSON.stringify(receipt, null, 2));
