import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers';

const U = '00000000-0000-0000-0000-000000000001';

async function seed(db: any) {
  await db.exec(`insert into auth.users values ('${U}','f@x.com');
    insert into profiles(id,email,role) values ('${U}','f@x.com','founder');`);
}

describe('schema', () => {
  it('migration applies and settings row exists with null caps', async () => {
    const db = await freshDb();
    const r = await db.query('select * from settings');
    expect(r.rows).toHaveLength(1);
    expect((r.rows[0] as any).investigation_cap_inr).toBeNull();
  });

  it('commercial fields: value needs a source, else not_estimated', async () => {
    const db = await freshDb(); await seed(db);
    await db.exec(`
      insert into prompt_versions(kind,name,content) values ('evidence_labels','l','x');
      insert into evidence_labels select id,'established','Established science','d',null,false from prompt_versions;
      insert into investigations(title,problem,cap_inr) values ('t','p',800);
      insert into findings(investigation_id,claim,evidence_label,label_set_id,source_type)
        select (select id from investigations),'c','established',(select id from prompt_versions),'preprint';`);
    const f = (await db.query('select id from findings')).rows[0] as any;
    await expect(db.query(`insert into finding_commercial(finding_id,field,value,status) values ('${f.id}','cost','5','sourced')`)).rejects.toThrow();
    await expect(db.query(`insert into finding_commercial(finding_id,field,value,status) values ('${f.id}','cost','5','not_estimated')`)).rejects.toThrow();
    await db.query(`insert into finding_commercial(finding_id,field,status) values ('${f.id}','cost','not_estimated')`);
  });

  it('finding must use a label that exists in its label set', async () => {
    const db = await freshDb(); await seed(db);
    await db.exec(`insert into prompt_versions(kind,name,content) values ('evidence_labels','l','x');
      insert into evidence_labels select id,'established','E','d',null,false from prompt_versions;
      insert into investigations(title,problem,cap_inr) values ('t','p',800);`);
    await expect(db.query(`insert into findings(investigation_id,claim,evidence_label,label_set_id,source_type)
      select (select id from investigations),'c','made_up',(select id from prompt_versions),'patent'`)).rejects.toThrow();
  });

  it('prompt versions are immutable and numbered per kind', async () => {
    const db = await freshDb();
    await db.exec(`insert into prompt_versions(kind,name,content) values ('stage1_plan','a','x'),('stage1_plan','b','y'),('stage2_research','c','z')`);
    const v = (await db.query(`select kind,version from prompt_versions order by kind,version`)).rows as any[];
    expect(v.map(r => `${r.kind}:${r.version}`)).toEqual(['stage1_plan:1','stage1_plan:2','stage2_research:1']);
    await expect(db.query(`update prompt_versions set content='changed'`)).rejects.toThrow(/immutable/);
  });

  it('only one active version per kind', async () => {
    const db = await freshDb();
    await db.exec(`insert into prompt_versions(kind,name,content,status) values ('stage1_plan','a','x','active')`);
    await expect(db.query(`insert into prompt_versions(kind,name,content,status) values ('stage1_plan','b','y','active')`)).rejects.toThrow();
  });

  it('duplicate DOIs and URLs are rejected (case-insensitive DOI)', async () => {
    const db = await freshDb();
    await db.exec(`insert into external_sources(source_type,doi,title,retrieved_via) values ('peer_reviewed_paper','10.1/ABC','t','openalex')`);
    await expect(db.query(`insert into external_sources(source_type,doi,title,retrieved_via) values ('peer_reviewed_paper','10.1/abc','t2','openalex')`)).rejects.toThrow();
  });

  it('spend functions sum the ledger', async () => {
    const db = await freshDb();
    await db.exec(`insert into investigations(title,problem,cap_inr) values ('t','p',800)`);
    const id = ((await db.query('select id from investigations')).rows[0] as any).id;
    await db.exec(`insert into cost_ledger(investigation_id,call_type,provider,model_or_tool,cost_inr) values
      ('${id}','llm','gemini','m',12.5),('${id}','tool','openalex','search',0.25)`);
    const s = (await db.query(`select investigation_spend_inr('${id}') s, month_spend_inr() m`)).rows[0] as any;
    expect(Number(s.s)).toBeCloseTo(12.75); expect(Number(s.m)).toBeCloseTo(12.75);
  });

  it('claim_job hands each job to exactly one worker and skips locked rows', async () => {
    const db = await freshDb();
    await db.exec(`insert into jobs(kind) values ('plan')`);
    const a = (await db.query(`select (claim_job('w1')).id as id`)).rows[0] as any;
    const b = (await db.query(`select (claim_job('w2')).id as id`)).rows[0] as any;
    expect(a.id).not.toBeNull(); expect(b.id).toBeNull();
  });
});
