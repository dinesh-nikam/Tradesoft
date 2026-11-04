import type { ErrorCode } from '@tradesoft/contracts';

/** A rule of the domain was broken. `code` is a catalogue code (05 §5.2), so the API maps it without a table. */
export class DomainError extends Error {
  override readonly name = 'DomainError';
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
