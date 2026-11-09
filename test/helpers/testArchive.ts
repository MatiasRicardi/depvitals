import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** Test-owned ustar writer. Buffers are inspected as data, never extracted/executed. */
export function tar(files: ReadonlyMap<string, Buffer>, type = '0'): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, bytes] of files) {
    const header = Buffer.alloc(512);
    const name = 'package/' + path;
    const split = name.length > 100 ? name.lastIndexOf('/') : -1;
    header.write(split < 0 ? name : name.slice(split + 1), 0, 100, 'utf8');
    if (split >= 0) header.write(name.slice(0, split), 345, 155, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.fill(32, 148, 156);
    header.write(type, 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
export function writeTestArchive(
  directory: string,
  files: ReadonlyMap<string, Buffer>,
  manifest: { name: string; version: string },
  tarBytes = tar(files),
): string {
  const { name, version } = manifest;
  const bytes = gzipSync(tarBytes);
  const pack = {
    name,
    version,
    filename: `${name}-${version}.tgz`,
    size: bytes.length,
    unpackedSize: [...files.values()].reduce((sum, value) => sum + value.length, 0),
    shasum: createHash('sha1').update(bytes).digest('hex'),
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    files: [...files].map(([path, value]) => ({ path, size: value.length })),
  };
  const path = join(directory, 'pack.json');
  writeFileSync(path, JSON.stringify([pack]));
  writeFileSync(join(directory, pack.filename), bytes);
  return path;
}
