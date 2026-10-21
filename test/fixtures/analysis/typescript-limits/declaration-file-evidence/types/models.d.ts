// Ambient declaration file mixing four syntaxes that look similar but are not equivalent.
/// <reference types="referenced-pkg" />

declare module 'untyped-lib' {
  export const value: string;
}

import type { ZodSchema } from 'zod';

export type Unparsed = import('other-pkg').Schema;

export type Shape = ZodSchema;
