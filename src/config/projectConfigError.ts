export type ProjectConfigErrorCode = 'unreadable' | 'invalid-json' | 'invalid-shape';

/** Operational configuration failure; broken present data must never become empty defaults. */
export class ProjectConfigError extends Error {
  readonly code: ProjectConfigErrorCode;

  constructor(message: string, code: ProjectConfigErrorCode, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProjectConfigError';
    this.code = code;
  }
}
