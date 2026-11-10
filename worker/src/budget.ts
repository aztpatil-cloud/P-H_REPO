// Budget governor. Pure logic over a Ledger interface so it is identical for every provider and tool.
// Rule: RESERVE the worst case before any paid call; if it doesn't fit, DON'T make the call.

export interface Ledger {
  investigationSpentInr(): Promise<number>;
  monthSpentInr(): Promise<number>;
  testMonthSpentInr(): Promise<number>;
}

export interface BudgetSettings {
  investigationCapInr: number | null;
  monthlyBudgetInr: number | null;
  testRunCapInr: number | null;
  wrapupReservePct: number;
  warnAtPct: number;
}

export interface BudgetConfig {
  investigationCapInr: number;
  monthlyBudgetInr: number;
  testRunCapInr: number | null;
  isTest: boolean;
  wrapupReservePct: number;
  warnAtPct: number;
}

export class BudgetNotConfigured extends Error {}

/** Stage 2 must not start until both caps exist. A per-investigation request can only LOWER the global cap. */
export function resolveBudgetConfig(s: BudgetSettings, opts: { requestedCapInr?: number; isTest?: boolean } = {}): BudgetConfig {
  if (s.investigationCapInr == null || s.monthlyBudgetInr == null)
    throw new BudgetNotConfigured('set the per-investigation cap and the monthly budget before starting research');
  const cap = opts.requestedCapInr != null ? Math.min(opts.requestedCapInr, s.investigationCapInr) : s.investigationCapInr;
  if (!(cap > 0)) throw new BudgetNotConfigured('effective investigation cap must be positive');
  return {
    investigationCapInr: cap, monthlyBudgetInr: s.monthlyBudgetInr, testRunCapInr: s.testRunCapInr,
    isTest: opts.isTest ?? false, wrapupReservePct: s.wrapupReservePct, warnAtPct: s.warnAtPct,
  };
}

export type Phase = 'research' | 'wrapup';
export type DenialReason = 'investigation_cap' | 'monthly_budget' | 'test_cap';
export interface Reservation { id: number; amountInr: number }
export type Decision =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: DenialReason; remainingInr: number };

export interface BudgetStatus {
  phase: Phase; spentInr: number; capInr: number; pctOfCap: number; warn: boolean;
  exhaustedReason: DenialReason | null;
}

export class BudgetGovernor {
  phase: Phase = 'research';
  private outstanding = new Map<number, number>();
  private nextId = 1;
  private exhausted: DenialReason | null = null;

  constructor(private cfg: BudgetConfig, private ledger: Ledger) {}

  private get reservedInr() { let t = 0; for (const v of this.outstanding.values()) t += v; return t; }

  /** Research may use (100 - wrapup reserve)% of the cap; wrap-up may use all of it. Monthly and test caps are always hard. */
  private investigationLimit(): number {
    return this.phase === 'research'
      ? this.cfg.investigationCapInr * (1 - this.cfg.wrapupReservePct / 100)
      : this.cfg.investigationCapInr;
  }

  async authorize(estimateInr: number): Promise<Decision> {
    if (this.phase === 'research' && this.exhausted) return { ok: false, reason: this.exhausted, remainingInr: 0 };
    const reserved = this.reservedInr;

    if (this.cfg.isTest) {
      if (this.cfg.testRunCapInr == null) return this.deny('test_cap', 0);
      const room = this.cfg.testRunCapInr - (await this.ledger.testMonthSpentInr()) - reserved;
      if (estimateInr > room) return this.deny('test_cap', room);
    }
    const monthRoom = this.cfg.monthlyBudgetInr - (await this.ledger.monthSpentInr()) - reserved;
    if (estimateInr > monthRoom) return this.deny('monthly_budget', monthRoom);

    const invRoom = this.investigationLimit() - (await this.ledger.investigationSpentInr()) - reserved;
    if (estimateInr > invRoom) return this.deny('investigation_cap', invRoom);

    const reservation = { id: this.nextId++, amountInr: estimateInr };
    this.outstanding.set(reservation.id, estimateInr);
    return { ok: true, reservation };
  }

  private deny(reason: DenialReason, room: number): Decision {
    if (this.phase === 'research') this.exhausted = reason;       // sticky: research is over
    return { ok: false, reason, remainingInr: Math.max(0, room) };
  }

  /** Call AFTER the actual cost has been written to the ledger (a brief double count is the safe direction). */
  settle(r: Reservation) { this.outstanding.delete(r.id); }
  /** Call when a reserved call failed without incurring cost. */
  release(r: Reservation) { this.outstanding.delete(r.id); }

  beginWrapup() { this.phase = 'wrapup'; }
  get exhaustedReason() { return this.exhausted; }

  async status(): Promise<BudgetStatus> {
    const spent = await this.ledger.investigationSpentInr();
    const pct = (spent / this.cfg.investigationCapInr) * 100;
    return { phase: this.phase, spentInr: spent, capInr: this.cfg.investigationCapInr, pctOfCap: pct, warn: pct >= this.cfg.warnAtPct, exhaustedReason: this.exhausted };
  }
}
