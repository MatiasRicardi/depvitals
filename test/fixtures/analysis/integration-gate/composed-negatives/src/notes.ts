// Synthetic fixture: package names appear only as inert text, never as an import position.
export const snippets: readonly string[] = [
  "import { render } from 'react';",
  "const schema = require('zod');",
  "await import('ts-jest');",
  "const note = `from 'react-dom' to 'undeclared-pkg'`;",
  "import 'jest-environment-jsdom';",
];
