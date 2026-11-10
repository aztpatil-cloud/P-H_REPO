import { describe, it, expect } from 'vitest';
import { approvePlan, runResearch, runStage1 } from '../src/pipeline/engine';
import { BudgetNotConfigured } from '../src/budget';
import { FOUNDER, PLAN, engineDeps, world, FakeSource, R1, R2, R3 } from './world';
import type { World } from './world';

const one = async (w: World, sql: string, p: unknown[] = []) => (await w.db.query(sql, p))[0] as any;
async function toApproval(w: World, o: Parameters<typeof engineDeps>[1] = {}, create: { cap?: number; confidential?: boolean } = {}) {
  const e = engineDeps(w, o);
  const id = await w.store.createInvestigation({ title: 'T', problem: 'Extend shelf life of a fruit snack without preservatives.', createdBy: FOUNDER, requestedCapInr: create.cap, confidential: create.confidential });
  await runStage1(e.deps, id);
  return { ...e, id };
}
async function fullRun(w: World, o: Parameters<typeof engineDeps>[1] = {}, create: { cap?: number } = {}) {
  const r = await toApproval(w, o, create);
  await approvePlan(r.deps, r.id, FOUNDER); await runResearch(r.deps, r.id);
  return r;
}

describe('stage 1 and the approval checkpoint', () => {
  it('produces a plan, stops at awaiting_approval, and stores a cost estimate; nothing deep has run', async () => {
    const w = await world(); const r = await toApproval(w);
    const inv = await w.store.investigation(r.id); expect(inv.status).toBe('awaiting_approval');
    const st = (await w.store.stage(r.id, 'plan'))!; expect(st.status).toBe('awaiting_approval'); expect(st.plan.sub_questions).toHaveLength(2);
    expect(st.progress.estimate.expectedInr).toBeGreaterThan(0); expect(st.progress.estimate.lowInr).toBeLessThan(st.progress.estimate.highInr);
    expect(r.openalex.calls).toEqual([]); expect(r.pubmed.calls).toEqual([]);                              // no searching before approval
    expect((await w.store.searchLog(r.id))).toHaveLength(0);
  });
  it('pins the prompt set and routing at creation, and charges stage 1 to the ledger with a price snapshot', async () => {
    const w = await world(); const r = await toApproval(w);
    const inv = await w.store.investigation(r.id); expect(inv.promptSetId).toBeTruthy(); expect(inv.routingSnapshotId).toBeTruthy();
    const row = await one(w, `select * from cost_ledger where investigation_id=$1`, [r.id]);
    expect(row.task).toBe('stage1_plan'); expect(Number(row.price_input_usd_per_m)).toBe(1); expect(Number(row.fx_rate)).toBe(90); expect(Number(row.cost_inr)).toBeGreaterThan(0);
    expect(row.model_call_id).toBeTruthy();
  });
  it('an invalid plan gets one corrective re-ask; a second invalid plan fails the run with the reason', async () => {
    const w = await world(); const r = await toApproval(w, { brain: { badPlanFirst: true } });
    expect((await w.store.investigation(r.id)).status).toBe('awaiting_approval');
    expect(Number((await one(w, `select count(*) c from model_calls where task='stage1_plan'`)).c)).toBe(2);
    const w2 = await world(); const r2 = await toApproval(w2, { brain: { alwaysBadPlan: true } });
    const inv = await w2.store.investigation(r2.id); expect(inv.status).toBe('failed'); expect(inv.coverageNote).toMatch(/could not produce a valid plan/);
  });
  it('approval validates edits, logs removed searches as skipped_user, and queues research', async () => {
    const w = await world(); const r = await toApproval(w);
    const bad = { ...PLAN, search_plan: [{ ...PLAN.search_plan[0]!, sub_question_id: 'nope' }] };
    await expect(approvePlan(r.deps, r.id, FOUNDER, bad as any)).rejects.toThrow(/not valid/);
    const edited = { ...PLAN, search_plan: PLAN.search_plan.filter(s => s.query !== 'b') };
    await approvePlan(r.deps, r.id, FOUNDER, edited);
    expect((await w.store.investigation(r.id)).status).toBe('researching');
    expect((await w.store.searchLog(r.id)).map((l: any) => `${l.query}:${l.status}`)).toEqual(['b:skipped_user']);
    expect((await one(w, `select count(*) c from jobs where kind='research'`)).c).toBe(1);
    await expect(approvePlan(r.deps, r.id, FOUNDER)).rejects.toThrow(/cannot be approved/);
  });
});

describe('research: a complete run', () => {
  it('finishes, with findings, approaches, experiments, a full report and a limited-coverage record', async () => {
    const w = await world(); const r = await fullRun(w);
    const inv = await w.store.investigation(r.id);
    expect(inv.status).toBe('complete'); expect(inv.coverageStatus).toBe('complete'); expect(inv.coverageNote).toBeNull();
    expect(inv.coverageProfile.limited).toBe(true); expect(inv.coverageProfile.reasons.join(' ')).toMatch(/only 2 source/); expect(inv.coverageProfile.reasons.join(' ')).toMatch(/abstracts only/);
    expect(inv.coverageProfile.contentBasis).toEqual({ abstract: 3, metadata_only: 0, full_text: 0 });
    const rep = (await w.store.latestReport(r.id))!; expect(rep.sections).toHaveLength(9); expect(rep.partial).toBe(false);
    expect(rep.banner).toMatch(/Limited coverage/); expect(rep.sections[0].content).toMatch(/Written section/);
    expect(rep.sections.some((s: any) => s.finding_ids.length > 0)).toBe(true);                              // sections trace back to findings via their citations
  });

  it('the coverage log records every search with its outcome, including the empty one', async () => {
    const w = await world(); const r = await fullRun(w);
    expect((await w.store.searchLog(r.id)).map((l: any) => `${l.origin}:${l.tool}:${l.query}:${l.status}:${l.result_count}`).sort()).toEqual(['plan:openalex:a:results:2', 'plan:openalex:c:empty:0', 'plan:pubmed:b:results:2']);
  });

  it('sources are deduplicated across searches, handled as S1..S3, and verified by DOI', async () => {
    const w = await world(); const r = await fullRun(w);
    const linked = await w.store.linkedSources(r.id); expect(linked.map(l => l.handle)).toEqual(['S1', 'S2', 'S3']);
    expect(linked.every(l => l.verification === 'verified')).toBe(true);
    expect(Number((await one(w, `select count(*) c from external_sources`)).c)).toBe(3);
  });

  it('findings: verification, label rules, fabricated references, and platform-authoritative source types', async () => {
    const w = await world(); const r = await fullRun(w);
    const f = Object.fromEntries((await w.store.findings(r.id)).map((x: any) => [x.claim.split(' ')[0] + x.claim.split(' ')[1], x]));
    const enz = f.Enzymescut, plasma = f.Coldplasma, hyp = f.Abarrier, sugar = f.Sugarreduction;
    expect(enz.verification_status).toBe('verified'); expect(enz.label_check).toBe('passed'); expect(enz.source_type).toBe('peer_reviewed_paper');
    expect(enz.extras.adjustments.join(' ')).toMatch(/source_type set from the cited source/); expect(enz.extras.adjustments.join(' ')).toMatch(/recorded as not estimated/);
    expect(enz.commercial).toMatchObject([{ field: 'cost driver', status: 'not_estimated', value: null }]);
    expect(enz.sources.find((s: any) => s.handle === 'S1')).toMatchObject({ quote_verified: true, reports_test_data: true });
    expect(plasma.label_check).toBe('failed'); expect(plasma.supported_label).toBe('experimental'); expect(plasma.label_check_note).toMatch(/needs 2 source/);
    expect(plasma.evidence_label).toBe('established_science');                                              // the model's label is never silently changed
    expect(hyp.label_check).toBe('passed'); expect(hyp.verification_status).toBe('unverified');
    expect(sugar.verification_status).toBe('partial'); expect(sugar.extras.rejectedRefs).toEqual(['S77']);
    expect(sugar.sources).toHaveLength(1);
  });

  it('approaches keep rejections, sourced commercial figures, linked findings, and ranking with the confidence cap', async () => {
    const w = await world(); const r = await fullRun(w);
    const a = Object.fromEntries((await w.store.approaches(r.id)).map((x: any) => [x.name, x]));
    expect(a['Cold plasma'].status).toBe('rejected'); expect(a['Cold plasma'].reason).toMatch(/preprint/);
    expect(a['Enzymatic sugar reduction'].finding_ids).toHaveLength(2);
    expect(a['Enzymatic sugar reduction'].rank).toBe(1); expect(a['Enzymatic sugar reduction'].confidence).toBe('medium');     // "high" capped on a limited-coverage run
    expect(a['Enzymatic sugar reduction'].uncertainty_note).toMatch(/capped at medium/);
    const c = await w.db.query(`select * from approach_commercial where approach_id=$1`, [a['Enzymatic sugar reduction'].id]);
    expect(c).toMatchObject([{ field: 'cost per pack', status: 'sourced', value: '₹0.4' }]);
    expect((await w.store.experiments(r.id))[0]).toMatchObject({ approach_name: 'Enzymatic sugar reduction', rank: 1 });
    expect((await w.store.nullResults(r.id)).map((n: any) => n.sub_question_id)).toEqual(['q2']);        // "nothing reliable found" is kept
  });

  it('every model call is on the ledger and the total equals the sum', async () => {
    const w = await world(); const r = await fullRun(w);
    const calls = Number((await one(w, `select count(*) c from model_calls where investigation_id=$1`, [r.id])).c);
    expect(calls).toBe(Number((await one(w, `select count(*) c from cost_ledger where investigation_id=$1`, [r.id])).c));
    expect(calls).toBeGreaterThanOrEqual(1 + 2 + 2 + 1 + 9);                                              // plan, 2 tool loops, 2 extractions, synthesis, 9 sections
    expect(await w.store.spendByInvestigation(r.id)).toBeCloseTo(Number((await one(w, `select sum(cost_inr) s from cost_ledger where investigation_id=$1`, [r.id])).s));
  });
});

describe('follow-up searches', () => {
  it('are limited per sub-question, logged with origin followup, and refused beyond the limit', async () => {
    const w = await world(); const r = await fullRun(w, { brain: { followups: 2 }, followups: 1 });
    const log = await w.store.searchLog(r.id); const fu = log.filter((l: any) => l.origin === 'followup');
    expect(fu.map((l: any) => l.query)).toEqual(['extra0']); expect(fu[0].tool).toBe('pubmed');
    expect(JSON.stringify(r.provider.calls.flatMap(c => c.messages))).toMatch(/follow-up limit reached/);
    expect((await w.store.investigation(r.id)).coverageProfile.queries.followups).toBe(1);
  });
});

describe('clean stop at the budget cap', () => {
  const heavy = { brain: { usage: { inputTokens: 60_000, outputTokens: 5_000 } } };
  it('stops, keeps everything found, logs the rest as skipped, and says "incomplete: budget reached"', async () => {
    const w = await world({ cap: 30 }); const r = await fullRun(w, heavy);
    const inv = await w.store.investigation(r.id);
    expect(inv.status).toBe('stopped_budget'); expect(inv.coverageStatus).toBe('incomplete_budget'); expect(inv.coverageNote).toBe('incomplete: budget reached');
    expect((await w.store.findings(r.id)).length).toBe(4);                                                  // q1 was extracted from the wrap-up reserve, not thrown away
    expect((await w.store.searchLog(r.id)).filter((l: any) => l.status === 'skipped_budget').map((l: any) => l.query)).toEqual(['c']);
    expect((await w.store.stage(r.id, 'research'))!.status).toBe('stopped');
    const rep = (await w.store.latestReport(r.id))!; expect(rep.partial).toBe(true); expect(rep.banner).toMatch(/Partial report/); expect(rep.banner).toMatch(/budget/);
    expect(rep.sections.some((s: any) => /not written by the model/.test(s.content))).toBe(true); expect(rep.sections).toHaveLength(9);
    expect(await w.store.spendByInvestigation(r.id)).toBeLessThanOrEqual(30);                               // the cap is never exceeded
  });
  it('a lower per-investigation request can only lower the cap, never raise it above the setting', async () => {
    const w = await world({ cap: 800 });
    const a = await w.store.createInvestigation({ title: 't', problem: 'p', createdBy: FOUNDER, requestedCapInr: 50 });
    const b = await w.store.createInvestigation({ title: 't', problem: 'p', createdBy: FOUNDER, requestedCapInr: 5000 });
    expect((await w.store.investigation(a)).capInr).toBe(50); expect((await w.store.investigation(b)).capInr).toBe(800);
  });
  it('the monthly budget is a hard stop for everything', async () => {
    const w = await world({ cap: 800, monthly: 20 }); const r = await fullRun(w, heavy);
    const inv = await w.store.investigation(r.id); expect(inv.status).toBe('stopped_budget'); expect(inv.coverageNote).toBe('incomplete: budget reached');
    // the scripted model reports far more tokens than the pre-call estimate, which a real provider cannot do beyond its
    // token-counting error; so the overshoot is bounded by ONE call (7.2), never runaway
    expect(await w.store.ledger(null).monthSpentInr()).toBeLessThanOrEqual(20 + 7.2 + 0.01);
  });
});

describe('stopping on request and resuming', () => {
  it('a founder stop ends research without further model calls; the report is assembled without the model', async () => {
    const w = await world(); let id = '';
    const e = engineDeps(w, { brain: { onCall: async (k) => { if (k === 'toolloop') await w.store.requestStop(id); } } });
    id = await w.store.createInvestigation({ title: 'T', problem: 'p', createdBy: FOUNDER });
    await runStage1(e.deps, id); await approvePlan(e.deps, id, FOUNDER); await runResearch(e.deps, id);
    const inv = await w.store.investigation(id);
    expect(inv.status).toBe('stopped_user'); expect(inv.coverageNote).toBe('incomplete: stopped by user');
    expect((await w.store.searchLog(id)).filter((l: any) => l.status === 'skipped_user').map((l: any) => l.query)).toEqual(['c']);
    expect(Number((await one(w, `select count(*) c from model_calls where task='report'`)).c)).toBe(0);
    expect((await w.store.latestReport(id))!.partial).toBe(true);
  });
  it('already-completed sub-questions are not redone after a restart', async () => {
    const w = await world(); const r = await toApproval(w); await approvePlan(r.deps, r.id, FOUNDER);
    const rs = (await w.store.stage(r.id, 'research'))!; await w.store.mergeProgress(rs.id, { completed: ['q1'], executed: ['q1|openalex|a', 'q1|pubmed|b'] });
    await runResearch(r.deps, r.id);
    expect(JSON.stringify(r.provider.calls.flatMap(c => c.messages.filter(m => m.role === 'user'))).includes('Sub-question q1:')).toBe(false);
    expect(r.openalex.calls).toEqual(['c']);
  });
  it('re-delivered jobs are harmless', async () => {
    const w = await world(); const r = await fullRun(w); const before = (await w.store.searchLog(r.id)).length;
    await runResearch(r.deps, r.id); await runStage1(r.deps, r.id);
    expect((await w.store.searchLog(r.id)).length).toBe(before); expect((await w.store.investigation(r.id)).status).toBe('complete');
  });
});

describe('pre-flight: fail at assignment time, never mid-run', () => {
  const failed = async (w: World, create: { confidential?: boolean } = {}) => { const r = await toApproval(w, {}, create); return { inv: await w.store.investigation(r.id), r }; };
  it('a model that is not cleared for confidential material cannot start a confidential investigation', async () => {
    const w = await world({ modelCleared: false }); const { inv, r } = await failed(w);
    expect(inv.status).toBe('failed'); expect(inv.coverageNote).toMatch(/not cleared for confidential material/);
    expect(Number((await one(w, `select count(*) c from model_calls`)).c)).toBe(0);                          // no model call was ever made
    expect(r.provider.calls).toHaveLength(0);
  });
  it('the same model may run a non-confidential investigation', async () => {
    const w = await world({ modelCleared: false }); const { inv } = await failed(w, { confidential: false });
    expect(inv.status).toBe('awaiting_approval');
  });
  it('an unverified price refuses to run', async () => {
    const w = await world({ priceVerified: false }); const { inv } = await failed(w);
    expect(inv.status).toBe('failed'); expect(inv.coverageNote).toMatch(/not verified/);
  });
  it('a missing exchange rate refuses to run; missing caps refuse to create an investigation; missing routes too', async () => {
    const w = await world({ fx: null }); expect((await failed(w)).inv.coverageNote).toMatch(/exchange rate/);
    const w2 = await world({ cap: null }); await expect(w2.store.createInvestigation({ title: 't', problem: 'p', createdBy: FOUNDER })).rejects.toBeInstanceOf(BudgetNotConfigured);
    const w3 = await world({ routes: false }); await expect(w3.store.createInvestigation({ title: 't', problem: 'p', createdBy: FOUNDER })).rejects.toThrow(/no model assigned/);
  });
});

describe('source failures are survivable and visible', () => {
  it('a failing source is logged as an error; the run continues and reports incomplete coverage honestly', async () => {
    const w = await world();
    const openalex = new FakeSource('openalex', { a: new (await import('../src/sources/types')).SourceError('server', 'upstream down') as any, c: [] }); const pubmed = new FakeSource('pubmed', { b: [R2, R3] });
    const r = await fullRun(w, { sources: { openalex, pubmed } });
    expect((await w.store.searchLog(r.id)).find((l: any) => l.query === 'a')).toMatchObject({ status: 'error', error: 'upstream down' });
    expect((await w.store.investigation(r.id)).status).toBe('complete');
  });
});
