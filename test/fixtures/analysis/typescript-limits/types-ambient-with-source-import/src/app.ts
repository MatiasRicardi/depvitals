// The only source reference to `express` is in type position, while the declared package is the
// `@types/express` stub. TypeScript erases this import, so it is not proof of a runtime dependency.
import type { Request } from 'express';

export function methodOf(req: Request): string {
  return req.method;
}
