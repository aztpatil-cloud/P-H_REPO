import type { Db } from './db/sql';

export interface JobRow { id: string; kind: string; payload: any; attempts: number; max_attempts: number }

/** Pulls one job at a time from the database queue. Crashed jobs are reclaimed by claim_job after five minutes. */
export async function runJobLoop(db: Db, handlers: Record<string, (payload: any) => Promise<void>>, o: { workerId: string; pollMs?: number; signal: AbortSignal; log?: (m: string) => void; once?: boolean }) {
  const sleep = (ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); o.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  const log = o.log ?? console.log;
  while (!o.signal.aborted) {
    const job = (await db.query<JobRow>(`select * from public.claim_job($1)`, [o.workerId]))[0];
    if (!job?.id) { if (o.once) return; await sleep(o.pollMs ?? 2000); continue; }
    try {
      const h = handlers[job.kind]; if (!h) throw new Error(`no handler for job kind ${job.kind}`);
      await h(job.payload); await db.query(`update public.jobs set status='done', last_error=null where id=$1`, [job.id]);
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500); log(`job ${job.kind} ${job.id} failed: ${msg}`);
      await db.query(job.attempts >= job.max_attempts ? `update public.jobs set status='failed', last_error=$2 where id=$1` : `update public.jobs set status='queued', last_error=$2, run_after = now() + interval '30 seconds' where id=$1`, [job.id, msg]);
    }
  }
}
