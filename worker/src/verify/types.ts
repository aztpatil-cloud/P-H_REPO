export type CheckStatus = 'verified' | 'unverified' | 'failed';
export interface CheckResult { status: CheckStatus; reason: string; detail?: Record<string, unknown> }
