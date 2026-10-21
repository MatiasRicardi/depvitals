// The runtime package is referenced by source but not declared, while the type-only stub is declared.
import type { Request } from 'express';

export function methodOf(req: Request): string {
  return req.method;
}
