export type ErrorKind =
  | 'rate_limit' | 'auth' | 'timeout' | 'context_length' | 'content_blocked'
  | 'schema_failure' | 'capability_missing' | 'price_unknown' | 'server' | 'unknown';

const RETRYABLE: ReadonlySet<ErrorKind> = new Set(['rate_limit', 'timeout', 'server']);

export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly opts: { retryAfterMs?: number; raw?: unknown; usage?: import('./types').Usage } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(kind);
  }
  get retryAfterMs() { return this.opts.retryAfterMs; }
  get raw() { return this.opts.raw; }
  /** Tokens already spent by attempts that ended in this error (so the ledger can still charge them). */
  get usage() { return this.opts.usage; }
}
