// Synthetic fixture: never executed, only parsed statically by the analyzer.
import { trim } from 'all-sources';
import { parse } from 'source-only';
import { helper } from 'undeclared-pkg';

export const value = trim(parse('input'), helper());
