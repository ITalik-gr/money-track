/**
 * §A6-BATCH — a mass run is a loop over an alarm, and this proves the loop stops: exact tick count,
 * and a run whose progress stops growing ends instead of re-arming forever.
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

test("§A6 batch: a batch kind cannot be started from the API", async () => {
  const { JOB_KINDS } = await import("../lib/ai/jobs.ts");
  // The route validates the requested kind against this list. A test fixture a client could start
  // is a way to spend alarm ticks on nothing, so the batch kinds stay off it until a real one
  // exists — and then it arrives deliberately, not because the list was a union of everything.
  assert.deepEqual(JOB_KINDS, ["advisor", "report", "budget"]);
});
