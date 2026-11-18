/** Offline v0.5.0 corpus comparison and Linux fresh-child cost receipt. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, release, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import Ajv from 'ajv';

import { identifySnapshot, identifyTool } from './evaluate-corpus.mjs';
import {
  archiveFiles,
  identifyBuild,
  verifyInstalledArchive,
  verifyMeasuredArchive,
} from './measurementIdentity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_DIRECTORY = join(ROOT, 'test/fixtures/external-corpus');
const CATALOGS = ['manifest.json', 'v0.5.0/applications.json'];
const WARMUPS = 2;
const REPEATS = 5;
const DENSE_LINES = 20_000;
const MODES = {
  terminal: [],
  json: ['--format', 'json'],
  'terminal-diagnostics': ['--diagnostics'],
  'json-diagnostics': ['--format', 'json', '--diagnostics'],
};
const NOTICE_TEXT = {
  'no-supported-sources': 'No supported source files were scanned.',
  'nested-package-inputs':
    'Some source files belong to nested packages. Findings use the selected root inventory. Scan a nested package separately to use its inventory.',
  'workspace-declared':
    'The root package.json declares workspaces. This scan uses only the selected root inventory.',
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

function inside(root, path) {
  const fromRoot = relative(root, path);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith('..' + sep))
  );
}

/** Review expectations are independent of the producer. The caller supplies its artifact schema. */
export function assertScan(capture, expected, validate, diagnostics = false) {
  assert.equal(capture.signal, null, 'Child was signalled');
  assert.equal(capture.status, expected.expectedProcess.status, 'Unexpected scan status');
  assert.equal(capture.stderr, '', 'Completed scan emitted stderr');
  assert.equal(expected.expectedProcess.stdout, 'completed-report');
  const report = JSON.parse(capture.stdout);
  assert(validate(report), JSON.stringify(validate.errors));
  assert.equal(report.mode, 'scan');
  assert.equal(report.query, null);
  assert.deepEqual(report.findings, expected.expectedFindings, 'Findings disagree with review');
  assert.deepEqual(
    { ignorePaths: report.scope.ignorePaths, ignoreDependencies: report.scope.ignoreDependencies },
    expected.expectedExclusions,
    'Effective policy disagrees with review',
  );
  if (diagnostics) {
    assert.deepEqual(
      report.diagnostics,
      expected.expectedScopeFacts,
      'Scope disagrees with review',
    );
    assert.deepEqual(Object.keys(report.diagnostics), [
      'sourceFilesScanned',
      'nestedPackageSourceFiles',
      'notices',
    ]);
    assert.equal(Object.keys(report).at(-1), 'diagnostics');
  } else assert(!Object.hasOwn(report, 'diagnostics'), 'Ordinary scan gained diagnostics');
  assert.equal(capture.stdout, JSON.stringify(report, null, 2) + '\n');
  return report;
}

export function summarize(samples) {
  assert.equal(samples.length, REPEATS, 'Expected five measured samples');
  const summary = (key) => {
    const ordered = samples.map((sample) => sample[key]).sort((a, b) => a - b);
    assert(ordered.every((value) => Number.isFinite(value) && value > 0));
    return { median: ordered[2], min: ordered[0], max: ordered.at(-1) };
  };
  return { elapsedMs: summary('elapsedMs'), peakRssKiB: summary('peakRssKiB') };
}

function expectedTerminal(findings, diagnostics) {
  const keys = ['unusedDependencies', 'unusedDevDependencies', 'missingDependencies'];
  const labels = ['Unused dependencies', 'Unused devDependencies', 'Missing dependencies'];
  const sections = keys.flatMap((key, index) =>
    findings[key].length === 0
      ? []
      : [
          `${labels[index]} (${findings[key].length})\n${findings[key].map((name) => '  ' + name).join('\n')}`,
        ],
  );
  const ordinary =
    'DepVitals\n\n' +
    (sections.length ? sections.join('\n\n') : 'No dependency issues found.') +
    '\n';
  if (diagnostics === undefined) return ordinary;
  return (
    ordinary +
    '\nScan diagnostics\n' +
    `  Source files scanned: ${diagnostics.sourceFilesScanned}\n` +
    `  Nested-package source files: ${diagnostics.nestedPackageSourceFiles}\n` +
    diagnostics.notices.map((code) => '  ' + NOTICE_TEXT[code] + '\n').join('')
  );
}

function artifact(root, archivePath) {
  root = realpathSync(resolve(root));
  archivePath = realpathSync(resolve(archivePath));
  const bytes = readFileSync(archivePath);
  const files = archiveFiles(bytes);
  verifyInstalledArchive(root, files);
  const manifest = json(join(root, 'package.json'));
  assert.equal(manifest.name, 'depvitals');
  assert.equal(manifest.bin.depvitals, './dist/cli/index.js');
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
  assert.equal(Object.keys(manifest.optionalDependencies ?? {}).length, 0);
  const lock = json(join(root, '../../package-lock.json')).packages['node_modules/depvitals'];
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.integrity, integrity);
  const validate = new Ajv({ allErrors: true }).compile(
    json(join(root, 'schemas/report-v1.schema.json')),
  );
  return {
    root,
    archivePath,
    files,
    validate,
    cli: join(root, 'dist/cli/index.js'),
    identity: {
      version: manifest.version,
      archiveSha256: hash(bytes),
      integrity,
      packedBytes: bytes.length,
      unpackedBytes: [...files.values()].reduce((sum, file) => sum + file.length, 0),
      fileCount: files.size,
    },
  };
}

export function compareCorpus(options) {
  assert.equal(process.platform, 'linux', 'The high-water measurement helper requires Linux');
  const review = json(join(CATALOG_DIRECTORY, 'v0.5.0/review.json'));
  assert.equal(review.reviewVersion, 1);
  assert.equal(review.status, 'REVIEWED');
  const catalogs = CATALOGS.map((file) => {
    const catalog = json(join(CATALOG_DIRECTORY, file));
    assert.equal(hash(JSON.stringify(catalog)), review.catalogSha256[file], 'Catalog changed');
    return catalog;
  });
  const frozenFiles = [...CATALOGS, 'v0.5.0/review.json'].map((file) => {
    const path = join(CATALOG_DIRECTORY, file);
    return { path, sha256: hash(readFileSync(path)) };
  });
  const roots = json(resolve(options.roots));
  const entries = catalogs.flatMap((catalog) => catalog.projects);
  assert.equal(entries.length, 6);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    review.projects.map((entry) => entry.id),
  );
  assert.deepEqual(Object.keys(roots).sort(), entries.map((entry) => entry.id).sort());
  const baseline = artifact(options.baselineRoot, options.baselineArchive);
  assert.equal(baseline.identity.version, review.baseline.version);
  assert.equal(baseline.identity.archiveSha256, review.baseline.archiveSha256);
  assert.equal(baseline.identity.integrity, review.baseline.archiveSri);
  const packPath = realpathSync(resolve(options.targetPack));
  const pack = json(packPath)[0];
  const measured = verifyMeasuredArchive(packPath, ROOT, identifyBuild(ROOT));
  const target = artifact(options.targetRoot, join(dirname(packPath), pack.filename));
  assert.equal(target.identity.archiveSha256, measured.archiveSha256);
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const tool = identifyTool(ROOT, sourceSha);
  const inputs = entries.map((entry, index) => {
    assert(isAbsolute(roots[entry.id]), 'Corpus roots must be absolute');
    const exported = realpathSync(roots[entry.id]);
    const root = realpathSync(resolve(exported, entry.selectedRoot));
    assert(inside(exported, root), 'Selected root escapes its export');
    const expected = review.projects[index];
    assert.equal(entry.snapshot.sha256, expected.snapshotSha256);
    assert.deepEqual(identifySnapshot(root), entry.snapshot, 'Input changed');
    return { ...entry, root, expected };
  });
  const requestedOutput = resolve(options.output);
  const output = join(realpathSync(dirname(requestedOutput)), requestedOutput.split(sep).at(-1));
  const protectedRoots = [
    ...inputs.map((input) => input.root),
    baseline.root,
    target.root,
    join(ROOT, 'src'),
    join(ROOT, 'dist'),
  ];
  assert(
    protectedRoots.every((root) => !inside(root, output)),
    'Output must be outside inputs and installations',
  );
  assert(!existsSync(output), 'Use a fresh output directory');
  mkdirSync(output);
  mkdirSync(join(output, 'captures'));
  const env = {
    ...process.env,
    CI: '1',
    DEPVITALS_NO_UPDATE_CHECK: '1',
    HOME: join(output, 'home'),
    USERPROFILE: join(output, 'home'),
    XDG_CACHE_HOME: join(output, 'cache'),
    LOCALAPPDATA: join(output, 'cache'),
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const helper = join(ROOT, 'scripts/measure-child.py');
  const helperHash = hash(readFileSync(helper));
  const harnessHash = hash(readFileSync(fileURLToPath(import.meta.url)));
  const pythonVersion = execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim();
  const artifacts = { baseline, target };
  const denseRoot = join(output, 'dense-input');
  mkdirSync(denseRoot);
  const denseManifest = '{"dependencies":{"phase6-evidence":"0.0.0"}}\n';
  const denseSource = "import 'phase6-evidence';\n".repeat(DENSE_LINES);
  writeFileSync(join(denseRoot, 'package.json'), denseManifest, { flag: 'wx' });
  writeFileSync(join(denseRoot, 'index.mjs'), denseSource, { flag: 'wx' });
  const dense = {
    id: 'dense-evidence',
    root: denseRoot,
    inventory: { supportedSourceFiles: 1, sourceBytes: Buffer.byteLength(denseSource) },
    snapshot: identifySnapshot(denseRoot),
    expected: {
      expectedProcess: { status: 0, stdout: 'completed-report', stderr: 'empty' },
      expectedFindings: {
        unusedDependencies: [],
        unusedDevDependencies: [],
        missingDependencies: [],
      },
      expectedExclusions: { ignorePaths: [], ignoreDependencies: [] },
      expectedScopeFacts: { sourceFilesScanned: 1, nestedPackageSourceFiles: 0, notices: [] },
      representativeEvidence: [],
    },
  };
  inputs.push(dense);

  function verify() {
    for (const file of frozenFiles) assert.equal(hash(readFileSync(file.path)), file.sha256);
    assert.deepEqual(identifyTool(ROOT, sourceSha), tool, 'Source/build identity changed');
    assert.equal(hash(readFileSync(helper)), helperHash);
    assert.equal(hash(readFileSync(fileURLToPath(import.meta.url))), harnessHash);
    for (const item of Object.values(artifacts)) {
      assert.equal(hash(readFileSync(item.archivePath)), item.identity.archiveSha256);
      verifyInstalledArchive(item.root, item.files);
    }
    for (const input of inputs)
      assert.deepEqual(identifySnapshot(input.root), input.snapshot, input.id);
  }
  function execute(id, command) {
    verify();
    const prefix = join(output, 'captures', id);
    const stdout = prefix + '.stdout';
    const stderr = prefix + '.stderr';
    const metrics = prefix + '.metrics.json';
    let result;
    try {
      result = spawnSync('python3', ['-I', helper, stdout, stderr, metrics, ...command], {
        cwd: output,
        env,
        encoding: 'utf8',
        timeout: 25_000,
        maxBuffer: 1024 * 1024,
      });
    } finally {
      verify();
    }
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    const metric = json(metrics);
    return {
      ...metric,
      stdout: readFileSync(stdout, 'utf8'),
      stderr: readFileSync(stderr, 'utf8'),
    };
  }
  const probeLow = execute('rss-probe-low', [
    process.execPath,
    '-e',
    "process.stdout.write('probe\\n')",
  ]);
  const probeHigh = execute('rss-probe-high', [
    process.execPath,
    '-e',
    "globalThis.probe = Buffer.alloc(64*1024*1024, 1); process.stdout.write('probe\\n')",
  ]);
  assert.equal(probeLow.status, 0);
  assert.equal(probeHigh.status, 0);
  assert.equal(probeLow.stdout, 'probe\n');
  assert.equal(probeHigh.stdout, 'probe\n');
  assert(probeHigh.peakRssKiB - probeLow.peakRssKiB > 32 * 1024, 'Peak-RSS calibration failed');

  function scan(input, role, mode, label) {
    return execute(`${input.id}.${role}.${mode}.${label}`, [
      process.execPath,
      artifacts[role].cli,
      input.root,
      ...MODES[mode],
    ]);
  }
  const rows = [];
  const comparison = [];
  for (const input of inputs) {
    const references = {};
    const modeList =
      input === dense ? Object.keys(MODES) : ['terminal', 'json', 'json-diagnostics'];
    for (const role of ['baseline', 'target']) {
      const supported = role === 'baseline' ? ['terminal', 'json'] : Object.keys(MODES);
      for (const mode of supported) {
        const result = scan(input, role, mode, 'reference');
        const diagnostic = mode.endsWith('diagnostics');
        if (mode.startsWith('json')) {
          const report = assertScan(result, input.expected, artifacts[role].validate, diagnostic);
          assert.equal(report.project.root, input.root);
          assert.equal(report.tool.version, artifacts[role].identity.version);
          if (diagnostic)
            assert(baseline.validate(report), JSON.stringify(baseline.validate.errors));
          if (input === dense) {
            assert.equal(report.packages.length, 1);
            assert.equal(report.packages[0].name, 'phase6-evidence');
            assert.equal(report.packages[0].evidence.length, DENSE_LINES);
            assert(
              report.packages[0].evidence.every(
                (fact, index) =>
                  fact.kind === 'source' &&
                  fact.file === 'index.mjs' &&
                  fact.reference === 'import' &&
                  fact.position.column === 8 &&
                  fact.specifier === 'phase6-evidence' &&
                  fact.position.offset === index * 26 + 7 &&
                  fact.position.line === index + 1,
              ),
            );
          }
        } else {
          assert.equal(result.signal, null);
          assert.equal(result.status, input.expected.expectedProcess.status);
          assert.equal(result.stderr, '');
          assert.equal(
            result.stdout,
            expectedTerminal(
              input.expected.expectedFindings,
              diagnostic ? input.expected.expectedScopeFacts : undefined,
            ),
          );
        }
        references[role + ':' + mode] = result;
      }
    }
    assert.equal(references['baseline:terminal'].stdout, references['target:terminal'].stdout);
    const baselineJson = JSON.parse(references['baseline:json'].stdout);
    const targetJson = JSON.parse(references['target:json'].stdout);
    const normalized = (doc) => ({ ...doc, tool: { ...doc.tool, version: 'comparison' } });
    assert.deepEqual(normalized(baselineJson), normalized(targetJson), 'Ordinary report changed');
    const { diagnostics, ...ordinary } = JSON.parse(references['target:json-diagnostics'].stdout);
    assert.deepEqual(ordinary, targetJson);
    const queries = [];
    for (const { name, status, ...expectedEvidence } of input.expected.representativeEvidence ??
      []) {
      const outputs = [];
      for (const role of ['baseline', 'target']) {
        const result = execute(`${input.id}.${role}.explain.${queries.length}`, [
          process.execPath,
          artifacts[role].cli,
          input.root,
          '--format',
          'json',
          '--explain',
          name,
        ]);
        assert.equal(result.status, status === 'missing' ? 1 : 0);
        assert.equal(result.signal, null);
        assert.equal(result.stderr, '');
        const report = JSON.parse(result.stdout);
        assert(artifacts[role].validate(report), JSON.stringify(artifacts[role].validate.errors));
        assert.deepEqual(report.query, { packageName: name, known: true });
        const [item] = report.packages;
        assert.equal(item.name, name);
        assert.equal(item.status, status);
        assert(
          item.evidence.some((fact) =>
            Object.entries(expectedEvidence).every(
              ([key, value]) => JSON.stringify(fact[key]) === JSON.stringify(value),
            ),
          ),
        );
        outputs.push(normalized(report));
      }
      assert.deepEqual(outputs[0], outputs[1]);
      queries.push({ name, status });
    }
    comparison.push({
      id: input.id,
      snapshotSha256: input.snapshot.sha256,
      status: input.expected.expectedProcess.status,
      findings: targetJson.findings,
      diagnostics,
      queries,
    });
    for (const mode of modeList) {
      const roles = mode.endsWith('diagnostics') ? ['target'] : ['baseline', 'target'];
      const samples = Object.fromEntries(roles.map((role) => [role, []]));
      for (let index = 0; index < WARMUPS + REPEATS; index++) {
        const order = index % 2 === 0 ? roles : [...roles].reverse();
        for (const role of order) {
          const sample = scan(input, role, mode, `sample-${index}`);
          const reference = references[role + ':' + mode];
          assert.equal(sample.status, reference.status);
          assert.equal(sample.signal, reference.signal);
          assert.equal(sample.stdout, reference.stdout, 'Output changed between samples');
          assert.equal(sample.stderr, reference.stderr);
          if (index >= WARMUPS)
            samples[role].push({ elapsedMs: sample.elapsedMs, peakRssKiB: sample.peakRssKiB });
        }
      }
      for (const role of roles) {
        rows.push({
          id: input.id,
          artifact: role,
          mode,
          sourceFiles: input.inventory.supportedSourceFiles,
          sourceBytes: input.inventory.sourceBytes,
          stdoutBytes: Buffer.byteLength(references[role + ':' + mode].stdout),
          ...summarize(samples[role]),
          samples: samples[role],
        });
      }
    }
    console.log('Compared and measured', input.id);
  }
  verify();
  const receipt = {
    comparisonVersion: 1,
    baseline: baseline.identity,
    target: target.identity,
    sourceSha,
    sourceSnapshotSha256: tool.source.sha256,
    build: measured,
    reviewSha256: hash(readFileSync(join(CATALOG_DIRECTORY, 'v0.5.0/review.json'))),
    catalogSha256: review.catalogSha256,
    host: {
      platform: process.platform,
      release: release(),
      arch: process.arch,
      node: process.version,
      python: pythonVersion,
      cpuModel: cpus()[0]?.model,
      logicalCpus: cpus().length,
      availableParallelism: availableParallelism(),
      totalMemoryBytes: totalmem(),
    },
    method: {
      warmups: WARMUPS,
      repeats: REPEATS,
      clock: 'Python perf_counter_ns around Popen/wait4',
      peakRss: 'Linux wait4 ru_maxrss, KiB, per Node child',
      stdoutLimitBytes: 32 * 1024 * 1024,
      childTimeoutSeconds: 20,
      harnessSha256: harnessHash,
      helperSha256: helperHash,
      rssProbe: { lowKiB: probeLow.peakRssKiB, allocated64MiBKiB: probeHigh.peakRssKiB },
    },
    dense: {
      generator: "20,000 LF-terminated import 'phase6-evidence'; lines",
      snapshot: dense.snapshot,
      manifestBytes: Buffer.byteLength(denseManifest),
      sourceBytes: Buffer.byteLength(denseSource),
      evidenceItems: DENSE_LINES,
    },
    comparison,
    rows,
  };
  save(join(output, 'receipt.json'), receipt);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keys = [
    'baseline-root',
    'baseline-archive',
    'target-root',
    'target-pack',
    'roots',
    'output',
  ];
  const { values } = parseArgs({
    options: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
    strict: true,
  });
  for (const key of keys)
    assert(typeof values[key] === 'string' && values[key].length > 0, 'Required --' + key);
  compareCorpus({
    baselineRoot: values['baseline-root'],
    baselineArchive: values['baseline-archive'],
    targetRoot: values['target-root'],
    targetPack: values['target-pack'],
    roots: values.roots,
    output: values.output,
  });
}
