// Node.js builtins referenced in their two accepted forms. Neither `node:fs` nor the bare `fs`
// form (nor `path`) may ever become a "missing" external package.
import fs from 'node:fs';
import NodeFs from 'fs';
import path from 'path';

export function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

export const legacy = NodeFs;
export const join = path.join;
