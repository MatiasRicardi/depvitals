import axios from 'axios';
import { map } from 'lodash';
import * as leftpad from 'left-pad';
import { format } from '@scope/formatter/subpath';
import React from 'react';
import { parse } from 'zod';
import * as fs from 'node:fs';

import { util } from './util';

export function run(value: string): void {
  axios.get('/');
  map([1, 2, 3], (x) => x);
  leftpad(value, 3, '0');
  format(value);
  parse(value);
  fs.existsSync(value);
  util(value);
}
