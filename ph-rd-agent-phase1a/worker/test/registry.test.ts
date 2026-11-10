import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers';

const F = '00000000-0000-0000-0000-00000000000f';
const M = '00000000-0000-0000-0000-0000000000aa';

async function seed(db: any) {
  await db.exec(`insert into auth.users values ('${F}','f@x.com'),('${M}','m@x.com');
    insert into profiles(id,email,role) values ('${F}','f@x.com','founder'),('${M}','m@x.com','member');
    insert into model_registry(id,provider,provider_model,display_name,status,context_tokens,max_output_tokens,supports_structured_output,supports_tool_calling)
      values ('11111111-1111-1111-1111-111111111111','p1','m1','Model 1','active',1000000,64000,true,true);`);
}
const MID = '11111111-1111-1111-1111-111111111111';
const asUser = (db: any, id: string) => db.exec(`select set_config('request.jwt.claim.sub','${id}',false)`);
const ok = async (db: any) => ((await db.query(`select model_confidential_ok('${MID}') ok`)).rows[0] as any).ok;

describe('registry gates', () => {
  it('confidential_ok needs: no-training verified, conformance, active', async () => {
    const db = await freshDb(); await seed(db);
    expect(await ok(db)).toBe(false);
    await asUser(db, F);
    await db.exec(`select verify_model_data_policy('${MID}','no','https://example.com/terms','retained briefly for abuse checks')`);
    expect(await ok(db)).toBe(false);                      // still no conformance
    await db.exec(`update model_registry set conformance_version=1, conformance_passed_at=now()`);
    expect(await ok(db)).toBe(true);
    await db.exec(`update model_registry set status='deprecated'`);
    expect(await ok(db)).toBe(false);
  });

  it('data-policy verification expires after 90 days', async () => {
    const db = await freshDb(); await seed(db); await asUser(db, F);
    await db.exec(`select verify_model_data_policy('${MID}','no','https://example.com/terms','note');
      update model_registry set conformance_passed_at=now()`);
    expect(await ok(db)).toBe(true);
    await db.exec(`update model_registry set data_policy_verified_at = now() - interval '91 days'`);
    expect(await ok(db)).toBe(false);
  });

  it('a provider that trains on inputs can never be confidential_ok', async () => {
    const db = await freshDb(); await seed(db); await asUser(db, F);
    await db.exec(`select verify_model_data_policy('${MID}','yes','https://example.com/terms','note');
      update model_registry set conformance_passed_at=now()`);
    expect(await ok(db)).toBe(false);
  });

  it('only the founder can verify; source url and note are mandatory', async () => {
    const db = await freshDb(); await seed(db);
    await asUser(db, M);
    await expect(db.query(`select verify_model_data_policy('${MID}','no','https://x','n')`)).rejects.toThrow(/founder only/);
    await asUser(db, F);
    await expect(db.query(`select verify_model_data_policy('${MID}','no','','n')`)).rejects.toThrow(/required/);
    await expect(db.query(`select verify_model_data_policy('${MID}','unknown','https://x','n')`)).rejects.toThrow(/explicitly/);
  });

  it('price verification is founder-only and audited', async () => {
    const db = await freshDb(); await seed(db);
    await db.exec(`insert into model_prices(id,model_registry_id,input_usd_per_m,output_usd_per_m,effective_from)
      values ('22222222-2222-2222-2222-222222222222','${MID}',0.75,3.75,'2026-07-21')`);
    await asUser(db, M);
    await expect(db.query(`select verify_model_price('22222222-2222-2222-2222-222222222222')`)).rejects.toThrow(/founder only/);
    await asUser(db, F);
    await db.exec(`select verify_model_price('22222222-2222-2222-2222-222222222222')`);
    const p = (await db.query(`select verified_at, verified_by from model_prices`)).rows[0] as any;
    expect(p.verified_at).not.toBeNull(); expect(p.verified_by).toBe(F);
    expect(((await db.query(`select count(*)::int c from audit_log where action='price_verified'`)).rows[0] as any).c).toBe(1);
  });

  it('a route cannot use the same model as primary and fallback', async () => {
    const db = await freshDb(); await seed(db);
    await expect(db.query(`insert into model_routes(task,primary_model_id,fallback_model_id) values ('report','${MID}','${MID}')`)).rejects.toThrow();
    await db.query(`insert into model_routes(task,primary_model_id) values ('report','${MID}')`);
  });

  it('ledger keeps the price snapshot and test spend is summed separately', async () => {
    const db = await freshDb(); await seed(db);
    await db.exec(`insert into cost_ledger(call_type,provider,model_or_tool,cost_inr,is_test,price_input_usd_per_m,price_output_usd_per_m,fx_rate)
      values ('llm','p1','m1',10,true,0.75,3.75,90),('llm','p1','m1',5,false,0.75,3.75,90)`);
    const r = (await db.query(`select month_test_spend_inr() t, month_spend_inr() m`)).rows[0] as any;
    expect(Number(r.t)).toBe(10); expect(Number(r.m)).toBe(15);
  });
});
