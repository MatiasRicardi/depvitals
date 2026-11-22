import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readRootTsconfig } from '../../../src/config/readRootTsconfig.js';
import { createScanContext } from '../../../src/core/scanContext.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat), readFile: vi.fn(actual.readFile) };
});

let root: string;
let config: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'depvitals-root-tsconfig-')));
  config = join(root, 'tsconfig.json');
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.resetAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('readRootTsconfig', () => {
  it('uses exact root-entry spelling and leaves other files unopened', async () => {
    await fs.writeFile(join(root, 'Tsconfig.json'), '{"extends":"wrong-case"}');
    await fs.writeFile(join(root, 'tsconfig.build.json'), '{"extends":"alternate"}');
    await fs.mkdir(join(root, 'nested'));
    await fs.writeFile(join(root, 'nested', 'tsconfig.json'), '{"extends":"nested"}');

    expect(await readRootTsconfig(root, await fs.readdir(root))).toEqual({ kind: 'absent' });
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('uses the existing scan context root snapshot and reads the selected file once', async () => {
    await fs.writeFile(join(root, 'package.json'), '{}');
    await fs.writeFile(join(root, 'depvitals.config.json'), '{"ignorePaths":["tsconfig.json"]}');
    await fs.writeFile(join(root, 'secondary.json'), '{"extends":"out-of-scope"}');
    await fs.writeFile(config, '{"references":[{"path":"./secondary.json"}]}');
    const context = await createScanContext(root);

    expect(vi.mocked(fs.readFile).mock.calls.some(([path]) => path === config)).toBe(false);
    vi.clearAllMocks();
    expect(await readRootTsconfig(context.manifest.root, context.rootEntries)).toEqual({
      kind: 'usable',
      extends: undefined,
    });
    expect(fs.lstat).toHaveBeenCalledExactlyOnceWith(config);
    expect(vi.mocked(fs.readFile).mock.calls).toEqual([[config]]);
  });

  it.each([
    ['absent property', '{}', undefined],
    [
      'decoded root key and scalar',
      String.raw`{"\u0065xtends":"  @scope\/shared  "}`,
      '  @scope/shared  ',
    ],
    [
      'one BOM and comments',
      '\uFEFF/* {"extends":false} */{"extends"// comment\r\n: "shared",}',
      'shared',
    ],
    [
      'string punctuation stays literal',
      '{"extends":["foo,]","https://example.org/*x*/","x//y",""],}',
      ['foo,]', 'https://example.org/*x*/', 'x//y', ''],
    ],
    ['empty array', '{"extends":[]}', []],
    [
      'nested duplicates ignored',
      '{"compilerOptions":{"extends":false,"extends":1},"extends":["real", "real",],}',
      ['real', 'real'],
    ],
    ['literal nested comment marker', '/* outer /* marker */{"extends":"real"}', 'real'],
    ['unrelated duplicate keys', '{"other":1,"other":2,"extends":"real"}// trailing', 'real'],
    [
      'standard JSON literals',
      '{"n":-12.5e-2,"a":null,"nested":[true,false,{"b":"c",},],}',
      undefined,
    ],
  ] as const)('accepts %s', async (_name, contents, expected) => {
    await fs.writeFile(config, contents);
    expect(await readRootTsconfig(root, ['tsconfig.json'])).toEqual({
      kind: 'usable',
      extends: expected,
    });
  });

  it.each([
    ['null root', 'null'],
    ['array root', '[{"extends":"nested"}]'],
    ['primitive root', 'false'],
    ['second BOM', '\uFEFF\uFEFF{}'],
    ['BOM after a comment', '/* comment */\uFEFF{}'],
    ['unterminated comment', '{"extends":"real" /*'],
    ['unterminated string', '{"extends":"real}'],
    ['invalid escape', String.raw`{"extends":"\x30"}`],
    ['invalid number', '{"x":01}'],
    ['comments do not join tokens', '{"x":1/* split */2}'],
    ['single quotes', "{'extends':'name'}"],
    ['unquoted key', '{extends:"name"}'],
    ['missing separator', '{"a":1 "extends":"real"}'],
    ['extra separator', '{"extends":"real",,}'],
    ['empty object comma', '{/* comment */,}'],
    ['empty array comma', '{"extends":[,]}'],
    ['array hole', '{"extends":["real", /* hole */,]}'],
    ['duplicate exact key', '{"extends":"real","extends":"repeat"}'],
    ['duplicate escaped key', String.raw`{"extends":"real","\u0065xtends":[]}`],
    ['mixed extends array', '{"extends":["real",null]}'],
    ['non-string extends', '{"extends":{"name":"real"}}'],
  ])('skips %s', async (_name, contents) => {
    await fs.writeFile(config, contents);
    expect(await readRootTsconfig(root, ['tsconfig.json'])).toEqual({ kind: 'skipped' });
  });

  it('handles deeply nested unrelated data without recursive scanning', async () => {
    const contents = '{"data":' + '['.repeat(2048) + '0' + ',]'.repeat(2048) + ',"extends":"real"}';
    await fs.writeFile(config, contents);
    expect(await readRootTsconfig(root, ['tsconfig.json'])).toEqual({
      kind: 'usable',
      extends: 'real',
    });
  });

  it('skips invalid UTF-8 even inside a quoted value', async () => {
    const bytes = Buffer.concat([
      Buffer.from('{"extends":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    await fs.writeFile(config, bytes);
    expect(await readRootTsconfig(root, ['tsconfig.json'])).toEqual({ kind: 'skipped' });
  });

  it('skips a present non-regular entry without reading it', async () => {
    await fs.mkdir(config);
    expect(await readRootTsconfig(root, ['tsconfig.json'])).toEqual({ kind: 'skipped' });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('skips a file selected in the snapshot that has since vanished', async () => {
    expect(await readRootTsconfig(root, ['tsconfig.json'])).toEqual({ kind: 'skipped' });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('skips an unreadable regular file after selection', async () => {
    await fs.writeFile(config, '{}');
    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );
    expect(await readRootTsconfig(root, ['tsconfig.json'])).toEqual({ kind: 'skipped' });
    expect(vi.mocked(fs.readFile).mock.calls).toEqual([[config]]);
  });

  it.skipIf(process.platform === 'win32')(
    'skips a root symlink without reading its target',
    async () => {
      const target = join(root, 'secondary.json');
      await fs.writeFile(target, '{"extends":"linked"}');
      await fs.symlink(target, config);
      expect(await readRootTsconfig(root, ['tsconfig.json'])).toEqual({ kind: 'skipped' });
      expect(fs.readFile).not.toHaveBeenCalled();
    },
  );
});
