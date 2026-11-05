/** Offline external-corpus observations. Inputs and the CLI are explicit, pre-acquired local data. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const equal = (actual, expected, message) => assert.deepEqual(actual, expected, message);
const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Resolve system aliases separately from the project symlink policy. */
function canonicalDirectory(root) {
  assert(isAbsolute(root), 'Snapshot root must be absolute');
  let expected = resolve(root);
  // macOS exposes these system directories through /private aliases. Do not exempt
  // any project-created link: the remaining path must still match realpath exactly.
  if (process.platform === 'darwin') {
    for (const alias of ['/tmp', '/var']) {
      if (expected === alias || expected.startsWith(alias + '/')) {
        expected = '/private' + expected;
        break;
      }
    }
  }
  assert(lstatSync(expected).isDirectory(), 'Snapshot root must be a real directory');
  const canonical = realpathSync(root);
  assert.equal(canonical, expected, 'Snapshot root must not traverse symlinks');
  return canonical;
}

/** A conservative whole-snapshot identity: directory names, regular bytes/modes and link text.
 * Symlinks are never followed. Source snapshots must exclude Git internals and installed packages.
 */
export function identifySnapshot(root) {
  root = canonicalDirectory(root);
  const entries = [];
  function visit(directory, prefix) {
    for (const name of readdirSync(directory).sort()) {
      assert(
        name !== '.git' && name !== 'node_modules',
        'Use a source export without .git/node_modules',
      );
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink())
        entries.push({ path, kind: 'symlink', target: readlinkSync(absolute) });
      else if (stat.isDirectory()) {
        entries.push({ path, kind: 'directory' });
        visit(absolute, path);
      } else {
        assert(stat.isFile(), `Unsupported snapshot entry: ${path}`);
        const bytes = readFileSync(absolute);
        entries.push({
          path,
          kind: 'file',
          bytes: bytes.length,
          executable: (stat.mode & 0o111) !== 0,
          sha256: sha256(bytes),
        });
      }
    }
  }
  visit(root, '');
  return { sha256: sha256(JSON.stringify(entries)), entries };
}

/** Bind complete source/build bytes and metadata to a caller-reviewed source SHA. No build occurs. */
export function identifyTool(root, sourceSha) {
  assert(
    typeof sourceSha === 'string' && /^[a-f0-9]{40}$/.test(sourceSha),
    'Expected full tool source SHA',
  );
  const metadata = json(join(root, 'package.json'));
  assert.equal(metadata.name, 'depvitals');
  equal(Object.keys(metadata.dependencies ?? {}), [], 'Runtime dependencies must remain empty');
  equal(
    Object.keys(metadata.optionalDependencies ?? {}),
    [],
    'Optional dependencies must remain empty',
  );
  const source = identifySnapshot(join(root, 'src'));
  const build = identifySnapshot(join(root, 'dist'));
  assert(
    build.entries.some((entry) => entry.path === 'cli/index.js' && entry.kind === 'file'),
    'Missing built CLI',
  );
  return {
    identityVersion: 1,
    sourceSha,
    version: metadata.version,
    packageJsonSha256: sha256(readFileSync(join(root, 'package.json'))),
    lockSha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))),
    workspaceSha256: sha256(readFileSync(join(root, 'pnpm-workspace.yaml'))),
    source,
    build,
  };
}

function validateCatalog(catalog) {
  assert.equal(catalog.catalogVersion, 1, 'Unknown corpus catalog version');
  assert(
    Array.isArray(catalog.projects) && catalog.projects.length > 0,
    'Expected corpus projects',
  );
  const ids = new Set();
  for (const entry of catalog.projects) {
    assert(
      typeof entry.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id),
      'Invalid corpus ID',
    );
    assert(!ids.has(entry.id), 'Duplicate corpus ID');
    ids.add(entry.id);
    assert(
      /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(entry.upstream),
      'Expected public upstream URL',
    );
    assert(/^[a-f0-9]{40}$/.test(entry.commit), 'Expected immutable upstream commit');
    assert(
      entry.selectedRoot === '.' ||
        (typeof entry.selectedRoot === 'string' &&
          entry.selectedRoot
            .split('/')
            .every((p) => p && p !== '.' && p !== '..' && !p.includes('\\') && !p.includes(':'))),
      'Invalid selected root',
    );
    assert(validHash(entry.snapshot.sha256), 'Missing snapshot hash');
    assert(Array.isArray(entry.snapshot.entries), 'Missing snapshot inventory');
    assert.equal(
      sha256(JSON.stringify(entry.snapshot.entries)),
      entry.snapshot.sha256,
      'Corrupt catalog inventory',
    );
    assert.equal(
      entry.expectationStatus,
      'NOT REVIEWED',
      'Initial evaluator does not certify expectations',
    );
    assert(!Object.hasOwn(entry, 'expected'), 'Step 101 owns reviewed expectations');
    // Step 100 runs unmodified upstream scope. Overlays require a separately identified staged entry.
    equal(
      entry.scope,
      { mode: 'upstream-default', overlays: [] },
      'Unsupported or changed evaluation scope',
    );
  }
}

/** Decode only the frozen v0.3 terminal corpus format, never production detection rules. */
function baselineFindings(stdout) {
  if (stdout === '') return null;
  const findings = { unusedDependencies: [], unusedDevDependencies: [], missingDependencies: [] };
  if (stdout === 'DepVitals\n\nNo dependency issues found.\n') return findings;
  assert(stdout.endsWith('\n'), 'Baseline report must end with LF');
  const sections = stdout.slice(0, -1).split('\n\n');
  assert.equal(sections.shift(), 'DepVitals', 'Invalid baseline report heading');
  assert(sections.length > 0, 'Incomplete baseline report');
  const categories = new Map([
    ['Unused dependencies', 'unusedDependencies'],
    ['Unused devDependencies', 'unusedDevDependencies'],
    ['Missing dependencies', 'missingDependencies'],
  ]);
  const seen = new Set();
  for (const section of sections) {
    const [heading, ...lines] = section.split('\n');
    const match = /^(.*?) \(([1-9]\d*)\)$/.exec(heading);
    const category = categories.get(match?.[1]);
    assert(category && !seen.has(category), 'Invalid or repeated baseline category');
    seen.add(category);
    assert.equal(Number(match[2]), lines.length, 'Invalid baseline count');
    findings[category] = lines.map((line) => {
      assert(line.startsWith('  '), 'Invalid baseline package row');
      return line.slice(2);
    });
  }
  return findings;
}

/** Compare hand-reviewed data with a captured receipt; never derive expectations from the CLI. */
export function verifyReviewedBaseline(receipt, review) {
  assert.equal(review.reviewVersion, 1, 'Unknown baseline review version');
  assert.equal(review.status, 'REVIEWED', 'Independent baseline review is incomplete');
  assert(
    typeof review.reviewedBy?.primary === 'string' &&
      review.reviewedBy.primary.length > 0 &&
      typeof review.reviewedBy.independent === 'string' &&
      review.reviewedBy.independent.length > 0 &&
      review.reviewedBy.primary !== review.reviewedBy.independent,
    'Distinct primary and independent reviewers required',
  );
  assert.equal(
    receipt.mode,
    'baseline-terminal-observation',
    'Expected baseline observation receipt',
  );
  assert.equal(receipt.tool.version, review.toolVersion, 'Review tool version changed');
  assert.equal(
    receipt.tool.source.sha256,
    review.sourceSnapshotSha256,
    'Review source identity changed',
  );
  assert.equal(receipt.catalogSha256, review.catalogSha256, 'Review corpus identity changed');
  equal(
    receipt.observations.map((p) => p.id).sort(),
    review.projects.map((p) => p.id).sort(),
    'Review must cover every corpus observation',
  );
  assert.equal(
    new Set(review.projects.map((p) => p.id)).size,
    review.projects.length,
    'Duplicate review ID',
  );
  for (const expected of review.projects) {
    const actual = receipt.observations.find((p) => p.id === expected.id);
    assert.equal(actual.nonMutationVerified, true, 'Unverified corpus mutation state');
    equal(
      { status: actual.status, stdout: actual.stdout, stderr: actual.stderr },
      expected.expectedProcess,
      `Reviewed process mismatch: ${expected.id}`,
    );
    if (expected.currentContractExpected !== null) {
      equal(
        Object.keys(expected.currentContractExpected).sort(),
        ['missingDependencies', 'unusedDependencies', 'unusedDevDependencies'],
        'Invalid reviewed finding categories',
      );
      for (const names of Object.values(expected.currentContractExpected)) {
        assert(
          Array.isArray(names) && names.every((name) => typeof name === 'string'),
          'Invalid reviewed findings',
        );
        equal(names, [...new Set(names)].sort(), 'Reviewed findings must be unique and sorted');
      }
    }
    equal(
      baselineFindings(actual.stdout),
      expected.currentContractExpected,
      `Reviewed finding mismatch: ${expected.id}`,
    );
  }
  return {
    matched: true,
    reviewSha256: sha256(JSON.stringify(review)),
    reviewedBy: review.reviewedBy,
  };
}

/** Capture the complete ordinary CLI pipeline, never importing the analyzer or reporter. */
export function evaluateCorpus(
  { catalog, roots, toolRoot, toolIdentity, reviewedBaseline },
  execute = spawnSync,
) {
  validateCatalog(catalog);
  equal(
    Object.keys(roots).sort(),
    catalog.projects.map((p) => p.id).sort(),
    'Roots must cover exactly the catalog IDs',
  );
  assert.equal(toolIdentity.identityVersion, 1, 'Unknown tool identity version');
  const verifyTool = () =>
    equal(
      identifyTool(toolRoot, toolIdentity.sourceSha),
      toolIdentity,
      'Tool source/build identity changed',
    );
  const verifyInputs = (entry, root) =>
    equal(identifySnapshot(root), entry.snapshot, `Input identity changed: ${entry.id}`);
  const selected = catalog.projects.map((entry) => {
    assert(
      typeof roots[entry.id] === 'string' && isAbsolute(roots[entry.id]),
      'Explicit absolute acquired roots are required',
    );
    const root = canonicalDirectory(resolve(roots[entry.id], entry.selectedRoot));
    verifyInputs(entry, root);
    return { entry, root };
  });
  // Preflight the whole corpus and tool before starting any subprocess.
  verifyTool();
  const environment = { ...process.env, CI: '1', DEPVITALS_NO_UPDATE_CHECK: '1' };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  const run = (args) => {
    const result = execute(process.execPath, [join(toolRoot, 'dist/cli/index.js'), ...args], {
      cwd: toolRoot,
      env: environment,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
    };
  };
  const version = run(['--version']);
  verifyTool();
  for (const { entry, root } of selected) verifyInputs(entry, root);
  assert(
    !version.error &&
      version.signal === null &&
      version.status === 0 &&
      version.stderr === '' &&
      version.stdout === `${toolIdentity.version}\n`,
    'Built CLI version differs from identity',
  );
  const observations = [];
  for (const { entry, root } of selected) {
    verifyTool();
    verifyInputs(entry, root);
    const result = run([root]);
    // Check mutation even when the child fails, times out or is terminated.
    verifyInputs(entry, root);
    verifyTool();
    assert(
      !result.error && result.signal === null && [0, 1].includes(result.status),
      `CLI did not complete: ${entry.id}`,
    );
    assert(
      typeof result.stdout === 'string' && typeof result.stderr === 'string',
      'Expected text process channels',
    );
    assert(
      (result.stdout !== '' && result.stderr === '') ||
        (result.status === 1 && result.stdout === '' && result.stderr !== ''),
      `Invalid CLI channels: ${entry.id}`,
    );
    observations.push({
      id: entry.id,
      commit: entry.commit,
      selectedRoot: entry.selectedRoot,
      inputSha256: entry.snapshot.sha256,
      scope: entry.scope,
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      expectationStatus: 'NOT REVIEWED',
      nonMutationVerified: true,
    });
  }
  // A later scan must not have changed a previously scanned project.
  for (const { entry, root } of selected) verifyInputs(entry, root);
  verifyTool();
  const receipt = {
    receiptVersion: 1,
    mode: 'baseline-terminal-observation',
    catalogSha256: sha256(JSON.stringify(catalog)),
    evaluatorSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    tool: toolIdentity,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    observations,
    expectationsReviewed: false,
  };
  if (reviewedBaseline !== undefined) {
    receipt.reviewVerification = verifyReviewedBaseline(receipt, reviewedBaseline);
    receipt.expectationsReviewed = true;
    for (const observation of observations) observation.expectationStatus = 'REVIEWED';
  }
  return receipt;
}

function main(args) {
  const keys = ['--manifest', '--roots', '--tool-root', '--tool-identity', '--output'];
  const required = [...keys];
  keys.push('--reviewed-baseline');
  const values = {};
  assert(
    args.length % 2 === 0 && args.length >= required.length * 2 && args.length <= keys.length * 2,
    'Usage: node scripts/evaluate-corpus.mjs --manifest <catalog.json> --roots <roots.json> --tool-root <depvitals> --tool-identity <identity.json> --output <receipt.json> [--reviewed-baseline <review.json>]',
  );
  for (let i = 0; i < args.length; i += 2) {
    assert(
      keys.includes(args[i]) && !Object.hasOwn(values, args[i]) && args[i + 1],
      'Unknown/duplicate option or missing value',
    );
    values[args[i]] = resolve(args[i + 1]);
  }
  assert(
    required.every((key) => Object.hasOwn(values, key)),
    'Missing required evaluator option',
  );
  const catalog = json(values['--manifest']);
  const roots = json(values['--roots']);
  const toolRoot = canonicalDirectory(values['--tool-root']);
  const toolIdentity = json(values['--tool-identity']);
  // Never write receipts inside source snapshots or the scanner source/build directories.
  const output = join(
    canonicalDirectory(dirname(values['--output'])),
    basename(values['--output']),
  );
  const within = (parent, child) => child === parent || child.startsWith(parent + sep);
  for (const root of Object.values(roots))
    assert(!within(canonicalDirectory(root), output), 'Receipt must be outside acquired inputs');
  for (const name of ['src', 'dist'])
    assert(
      !within(canonicalDirectory(join(toolRoot, name)), output),
      'Receipt must be outside tool source/build',
    );
  const reviewedBaseline = values['--reviewed-baseline']
    ? json(values['--reviewed-baseline'])
    : undefined;
  const receipt = evaluateCorpus({ catalog, roots, toolRoot, toolIdentity, reviewedBaseline });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(
    `Captured ${receipt.observations.length} corpus observations; expectations ${receipt.expectationsReviewed ? 'REVIEWED and matched' : 'remain NOT REVIEWED'}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Corpus evaluation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
