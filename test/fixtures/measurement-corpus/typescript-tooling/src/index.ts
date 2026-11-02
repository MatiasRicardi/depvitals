import type { Model } from 'ts-model-live'; export function local(require: (name: string) => Model) { return require('ts-shadow-decoy'); }
