import axios from 'axios';
import 'side-effect-pkg';
export { helper } from 'reexport-pkg';
import { chunk } from 'lodash/chunk';
import('dynamic-pkg').then((mod) => mod);
import fs from 'node:fs';
import { local } from './local';

export function run(value: string): void {
  axios.get(value);
  chunk([1, 2, 3], 2);
  local(value);
}
