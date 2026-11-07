/** Development-only identity checks shared by the measurement runner and its regressions. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const hash = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);

/** Include root name-presence state without reading through opaque detector barriers. */
export function identifyInputs(root, sources) {
  // A conservative superset avoids a second, drifting copy of detector filename allowlists.
  const rootEntries = readdirSync(root).sort();
  const paths = new Set(sources);
  paths.add(join(root, 'package.json'));
  for (const source of sources) {
    let directory = dirname(source);
    while (directory !== root) {
      const metadata = join(directory, 'package.json');
      if (existsSync(metadata)) paths.add(metadata);
      directory = dirname(directory);
    }
  }
  for (const name of rootEntries) {
    if (name.toLowerCase() === '.eslintrc.json' || name === 'depvitals.config.json') {
      const path = join(root, name);
      if (lstatSync(path).isFile()) paths.add(path);
    }
  }
  const files = [...paths]
    .map((path) => {
      assert(lstatSync(path).isFile(), `Measurement input must be a regular file: ${path}`);
      const bytes = readFileSync(path);
      return {
        path: relative(root, path).split(sep).join('/'),
        sha256: hash(bytes),
        bytes: bytes.length,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { sha256: hash(JSON.stringify({ rootEntries, files })), rootEntries, files };
}

/** Hash built code and selected packaged schema assets; retain legacy dist-only identities. */
export function identifyBuild(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const directories = ['dist'];
  if (manifest.files?.includes('schemas')) directories.push('schemas');
  const files = [];
  const visit = (directory) => {
    assert(
      lstatSync(directory).isDirectory(),
      `Measured build must be a regular directory: ${directory}`,
    );
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        assert(entry.isFile(), `Measured build must be a regular file: ${path}`);
        files.push({
          path: relative(root, path).split(sep).join('/'),
          sha256: hash(readFileSync(path)),
        });
      }
    }
  };
  for (const directory of directories) visit(join(root, directory));
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Inspect regular files from this package's bounded ustar archive; never extract or execute it. */
export function archiveFiles(bytes) {
  const tar = gunzipSync(bytes);
  const files = new Map();
  const string = (header, start, length) => {
    const field = header.subarray(start, start + length);
    const end = field.indexOf(0);
    return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
  };
  const octal = (text) => {
    const value = text.trim();
    assert(/^[0-7]+$/.test(value), 'Invalid tar numeric field');
    const number = Number.parseInt(value, 8);
    assert(Number.isSafeInteger(number), 'Invalid tar numeric range');
    return number;
  };
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert(
        tar.subarray(offset).every((byte) => byte === 0),
        'Unexpected data after tar terminator',
      );
      return files;
    }
    const checksum = [...header].reduce(
      (sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte),
      0,
    );
    assert.equal(octal(string(header, 148, 8)), checksum, 'Invalid tar header checksum');
    const size = octal(string(header, 124, 12));
    const type = header[156];
    const start = offset + 512;
    const end = start + size;
    const next = start + Math.ceil(size / 512) * 512;
    assert(end <= tar.length && next <= tar.length, 'Truncated tar entry');
    const prefix = string(header, 345, 155);
    const name = (prefix ? prefix + '/' : '') + string(header, 0, 100);
    if (type === 53) {
      assert.equal(size, 0, 'Directory entry has payload');
    } else {
      assert(type === 0 || type === 48, `Unsupported tar entry type for ${name}`);
      assert(name.startsWith('package/') && !name.includes('\\'), `Invalid packaged path: ${name}`);
      const path = name.slice('package/'.length);
      assert(
        path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
        `Invalid packaged path: ${name}`,
      );
      assert(!files.has(path), `Duplicate packaged path: ${path}`);
      files.set(path, tar.subarray(start, end));
    }
    offset = next;
  }
  assert.fail('Missing tar terminator');
}

/** Bind pack metadata, actual adjacent archive bytes and every packaged code/schema file to the current measured build. */
export function verifyMeasuredArchive(packPath, root, build) {
  const metadata = JSON.parse(readFileSync(packPath, 'utf8'));
  assert(Array.isArray(metadata) && metadata.length === 1, 'Expected one npm pack result');
  const [pack] = metadata;
  assert(
    typeof pack.filename === 'string' && /^[^/\\:]+\.tgz$/.test(pack.filename),
    'Expected an adjacent .tgz filename',
  );
  const archivePath = join(dirname(resolve(packPath)), pack.filename);
  assert(lstatSync(archivePath).isFile(), 'Measurement archive must be a regular file');
  const bytes = readFileSync(archivePath);
  assert.equal(bytes.length, pack.size, 'Archive size differs from pack metadata');
  assert.equal(hash(bytes, 'sha1'), pack.shasum, 'Archive SHA-1 differs from pack metadata');
  assert.equal(
    'sha512-' + hash(bytes, 'sha512', 'base64'),
    pack.integrity,
    'Archive SHA-512 differs from pack metadata',
  );
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pack.version, manifest.version, 'Archive version differs from measured project');
  assert.equal(pack.name, manifest.name, 'Archive name differs from measured project');
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
  assert.equal(Object.keys(manifest.optionalDependencies ?? {}).length, 0);
  const actual = archiveFiles(bytes);
  assert(Array.isArray(pack.files), 'Missing packaged-file metadata');
  const listed = pack.files.map((file) => file.path).sort();
  assert.deepEqual(listed, [...actual.keys()].sort(), 'Pack file list differs from archive');
  let unpackedBytes = 0;
  for (const file of pack.files) {
    assert.equal(actual.get(file.path).length, file.size, `Pack file size differs: ${file.path}`);
    unpackedBytes += file.size;
  }
  assert.equal(unpackedBytes, pack.unpackedSize, 'Unpacked size differs from archive');
  const expected = new Map(build.map((file) => [file.path, file.sha256]));
  for (const path of ['package.json', 'README.md', 'LICENSE'])
    expected.set(path, hash(readFileSync(join(root, path))));
  assert(expected.has('dist/cli/index.js'), 'Measured build has no CLI entrypoint');
  assert.deepEqual(
    [...actual.keys()].sort(),
    [...expected.keys()].sort(),
    'Archive file set differs from measured build',
  );
  for (const [path, digest] of expected)
    assert.equal(
      hash(actual.get(path)),
      digest,
      `Archive file differs from measured build: ${path}`,
    );
  return {
    version: pack.version,
    filename: pack.filename,
    packedBytes: bytes.length,
    unpackedBytes,
    fileCount: actual.size,
    integrity: pack.integrity,
    shasum: pack.shasum,
    archiveSha256: hash(bytes),
    matchedBuildSha256: hash(JSON.stringify(build)),
    runtimeDependencies: Object.keys(manifest.dependencies ?? {}),
    optionalDependencies: Object.keys(manifest.optionalDependencies ?? {}),
  };
}
