import { describe, it, expect } from 'vitest';
import { BudgetGovernor, BudgetNotConfigured, resolveBudgetConfig, type BudgetConfig, type Ledger } from '../src/budget';

class MemLedger implements Ledger {
  inv = 0; month = 0; test = 0;
  async investigationSpentInr() { return this.inv; }
  async monthSpentInr() { return this.month; }
  async testMonthSpentInr() { return this.test; }
}
const cfg = (o: Partial<BudgetConfig> = {}): BudgetConfig =>
  ({ investigationCapInr: 800, monthlyBudgetInr: 10_000, testRunCapInr: null, isTest: false, wrapupReservePct: 10, warnAtPct: 80, ...o });

describe('resolveBudgetConfig', () => {
  const settings = { investigationCapInr: 800, monthlyBudgetInr: 10_000, testRunCapInr: null, wrapupReservePct: 10, warnAtPct: 80 };
  it('refuses to run until both caps are set', () => {
    expect(() => resolveBudgetConfig({ ...settings, investigationCapInr: null })).toThrow(BudgetNotConfigured);
    expect(() => resolveBudgetConfig({ ...settings, monthlyBudgetInr: null })).toThrow(BudgetNotConfigured);
  });
  it('a per-investigation request can lower the cap but never raise it', () => {
    expect(resolveBudgetConfig(settings, { requestedCapInr: 300 }).investigationCapInr).toBe(300);
    expect(resolveBudgetConfig(settings, { requestedCapInr: 5000 }).investigationCapInr).toBe(800);
  });
});

describe('BudgetGovernor', () => {
  it('authorizes within budget and denies when the worst case would breach', async () => {
    const l = new MemLedger(); const g = new BudgetGovernor(cfg(), l);
    expect((await g.authorize(100)).ok).toBe(true);
    l.inv = 600;
    const d = await g.authorize(150);                       // 600 + 100 outstanding + 150 = 850 > 720
    expect(d).toMatchObject({ ok: false, reason: 'investigation_cap' });
  });

  it('research stops at 90% of the cap; the 10% wrap-up reserve is only usable in wrap-up', async () => {
    const l = new MemLedger(); const g = new BudgetGovernor(cfg(), l);
    l.inv = 700;
    expect((await g.authorize(30)).ok).toBe(false);          // 730 > 720
    g.beginWrapup();
    expect((await g.authorize(30)).ok).toBe(true);           // 730 <= 800
    l.inv = 790;
    expect((await g.authorize(30)).ok).toBe(false);          // never beyond the cap
  });

  it('research denial is sticky, even for a cheaper call that would fit', async () => {
    const l = new MemLedger(); const g = new BudgetGovernor(cfg(), l);
    l.inv = 715;
    expect((await g.authorize(50)).ok).toBe(false);
    expect((await g.authorize(1)).ok).toBe(false);
    expect(g.exhaustedReason).toBe('investigation_cap');
  });

  it('outstanding reservations stop parallel calls from jointly overspending', async () => {
    const g = new BudgetGovernor(cfg({ investigationCapInr: 100, wrapupReservePct: 0 }), new MemLedger());
    const a = await g.authorize(60); const b = await g.authorize(60);
    expect(a.ok).toBe(true); expect(b.ok).toBe(false);
  });

  it('settling releases the reservation', async () => {
    const l = new MemLedger(); const g = new BudgetGovernor(cfg({ investigationCapInr: 100, wrapupReservePct: 0 }), l);
    const a = await g.authorize(60); if (!a.ok) throw new Error();
    l.inv = 40; g.settle(a.reservation);                    // actual cost was 40, ledger already written
    expect((await g.authorize(55)).ok).toBe(true);          // 40 + 55 = 95
  });

  it('monthly budget is a hard stop in BOTH phases', async () => {
    const l = new MemLedger(); l.month = 9_990;
    const g = new BudgetGovernor(cfg(), l);
    expect(await g.authorize(20)).toMatchObject({ ok: false, reason: 'monthly_budget' });
    g.beginWrapup();
    expect(await g.authorize(20)).toMatchObject({ ok: false, reason: 'monthly_budget' });
    expect((await g.authorize(5)).ok).toBe(true);
  });

  it('test runs are blocked while the test cap is unset, and capped when set', async () => {
    const l = new MemLedger();
    const blocked = new BudgetGovernor(cfg({ isTest: true, testRunCapInr: null }), l);
    expect(await blocked.authorize(1)).toMatchObject({ ok: false, reason: 'test_cap' });
    l.test = 480;
    const g = new BudgetGovernor(cfg({ isTest: true, testRunCapInr: 500 }), l);
    expect((await g.authorize(15)).ok).toBe(true);
    expect(await g.authorize(10)).toMatchObject({ ok: false, reason: 'test_cap' });   // 480 + 15 outstanding + 10 > 500
  });

  it('non-test runs ignore the test cap', async () => {
    const g = new BudgetGovernor(cfg({ isTest: false, testRunCapInr: 1 }), new MemLedger());
    expect((await g.authorize(100)).ok).toBe(true);
  });

  it('status warns at the configured percentage', async () => {
    const l = new MemLedger(); const g = new BudgetGovernor(cfg(), l);
    l.inv = 639; expect((await g.status()).warn).toBe(false);
    l.inv = 640; expect((await g.status()).warn).toBe(true);
  });
});
