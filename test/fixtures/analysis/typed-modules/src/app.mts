// A real import inside a `.mts` file must contribute to dependency analysis: `zod` is declared and
// used here (so it stays unused-free), while `missing-in-mts` is undeclared and must be reported as
// missing, proving the `.mts` file was actually analyzed.
import { z } from 'zod';
import 'missing-in-mts';

export const check = z.string;
