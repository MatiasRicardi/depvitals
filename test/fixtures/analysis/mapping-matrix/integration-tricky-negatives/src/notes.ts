// Nothing here is real usage: the specifiers live inside strings, so `react` and `lodash` must stay
// unused and no missing finding may appear for `express` or `zod`.
export const esmSnippet = 'import react from "react";';
export const cjsSnippet = "const lodash = require('lodash');";
export const dynamicSnippet = 'import("zod")';
export const expressSnippet = `require('express')`;
