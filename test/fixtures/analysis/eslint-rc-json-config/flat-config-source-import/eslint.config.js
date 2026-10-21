// A modern flat-config entrypoint is an ordinary source file for the v0.1.0 scanner: its static
// import is usage evidence for `@eslint/js`, with no special flat-config detection anywhere.
import js from '@eslint/js';

export default [js.configs.recommended];
