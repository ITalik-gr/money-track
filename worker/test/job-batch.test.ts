/**
 * A mass run is a LOOP OVER AN ALARM, and this is the test that says the loop stops.
 *
 * §A6 covered one generation per tick. A re-sweep or a batch enrich is different in kind: it goes
 * in batches, stays unfinished in between, and re-arms the object each time. The risk that kept
 * this out of the queue for months is not a stuck job — it is the opposite: a wrong stop
 * condition means a Durable Object that wakes itself forever, and for a real kind every one of
 * those wake-ups is a paid model call. The payload cannot be tested without a live key; the LOOP
 * can, against `noop_batch`, which counts and costs nothing.
 *
 * So what is pinned here is exactly the dangerous half: how many ticks a run takes, that it ends,
 * and that an executor which stops moving ends it too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, testEnv } from "./harness.ts";
import { enqueueJob, runNextJob, hasQueuedJobs, listJobs } from "../lib/ai/jobs.ts";
import type { Env } from "../env.ts";

/** Drive the scheduler the way the alarm does, with a hard ceiling so a spin fails the test. */
async function drain(env: Env, ceiling = 50): Promise<number> {
  let ticks = 0;
  while (await runNextJob(env)) {
    if (++ticks > ceiling) assert.fail(`the run did not stop after ${ceiling} ticks`);
  }
  return ticks;
}

const job = async (env: Env) => (await listJobs(env))[0];

test("§A6 batch: 10 batches of 3 finish in exactly 10 ticks, and not one more", async () => {
  const db = migratedDb();
  const env = testEnv(db) as unknown as Env;
  await enqueueJob(env, "noop_batch", { total: 30, size: 3 });

  const ticks = await drain(env);

  // Exactly ten: a spare tick means the run woke the object for nothing, which at scale is what
  // the whole caution was about. Ten also proves `attempts` is reset by a tick that moved —
  // MAX_ATTEMPTS is 3, so before that reset this run died at batch four.
  assert.equal(ticks, 10);
  const row = await job(env);
  assert.equal(row.status, "done");
  assert.equal(row.progress_done, 30);
  assert.equal(row.progress_total, 30);
  assert.equal(row.error, null);
  // And the scheduler is quiet: `armAlarm` asks exactly this before setting the next alarm.
  assert.equal(await hasQueuedJobs(env.DB), false);
});

test("§A6 batch: progress is visible BETWEEN ticks, not only at the end", async () => {
  const db = migratedDb();
  const env = testEnv(db) as unknown as Env;
  await enqueueJob(env, "noop_batch", { total: 10, size: 4 });

  await runNextJob(env);
  const mid = await job(env);
  // 'queued', not 'running': that is what makes the row claimable on the very next pass instead
  // of waiting out STALE_RUNNING_SEC — the mechanism the whole loop rests on.
  assert.equal(mid.status, "queued");
  assert.equal(mid.progress_done, 4);
  assert.equal(mid.progress_total, 10);
  assert.equal(await hasQueuedJobs(env.DB), true);

  assert.equal(await drain(env), 2); // 8, then 10
  assert.equal((await job(env)).status, "done");
});

test("§A6 batch: an executor that stops moving ends the job instead of spinning", async () => {
  const db = migratedDb();
  const env = testEnv(db) as unknown as Env;
  await enqueueJob(env, "noop_batch", { total: 30, size: 3, stall: true });

  const ticks = await drain(env);

  // One tick, then stopped: `progress_done` must STRICTLY increase, whatever the executor claims
  // about being unfinished. This is the guard, and it is the reason a mass run cannot burn an
  // account's model budget through an alarm nobody is watching.
  assert.equal(ticks, 1);
  const row = await job(env);
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /no progress at 0\/30/);
  assert.equal(await hasQueuedJobs(env.DB), false);
});

test("§A6 batch: nothing to do is done, not a run of zero batches", async () => {
  const db = migratedDb();
  const env = testEnv(db) as unknown as Env;
  await enqueueJob(env, "noop_batch", { total: 0, size: 5 });

  assert.equal(await drain(env), 1);
  const row = await job(env);
  assert.equal(row.status, "done");
  assert.equal(row.progress_total, 0);
});

test("§A6 batch: a batch kind cannot be started from the API", async () => {
  const { JOB_KINDS } = await import("../lib/ai/jobs.ts");
  // The route validates the requested kind against this list. A test fixture a client could start
  // is a way to spend alarm ticks on nothing, so the batch kinds stay off it until a real one
  // exists — and then it arrives deliberately, not because the list was a union of everything.
  assert.deepEqual(JOB_KINDS, ["advisor", "report", "budget"]);
});
