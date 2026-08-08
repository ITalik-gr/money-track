/**
 * §A6 — who is left to run a queued AI job.
 *
 * The reported symptom was narrow ("background AI only switched on the second try, on the demo
 * account"), but the cause is general: 'running' is a TRACE that someone claimed the row, not a
 * promise that anyone is still working on it. Every selector treated it as the latter.
 *
 * Chain that produced the report. A demo runs its jobs inside the HTTP request, because the
 * sandbox's single alarm was doing nothing but the 24h self-destruct. The visitor asked for advice
 * and left the tab; the isolate died mid-generation; the row stayed 'running'. From then on
 * `enqueueJob` — correctly idempotent per kind — answered every further click with that dead row's
 * id, the route only executed when `created` was true, and the alarm skipped the queue entirely.
 * Three separate pieces each doing something reasonable, and the button never worked again.
 *
 * So the tests below pin the three independent repairs, because any one of them alone still leaves
 * a way to strand the work.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, testEnv } from "./harness.ts";
import { seed } from "./fixture.ts";
import { enqueueJob, hasQueuedJobs, runNextJob } from "../lib/ai/jobs.ts";
import type { Env } from "../env.ts";

const NOW = Math.floor(Date.now() / 1000);

const dbWithJobs = () => {
  const db = migratedDb();
  seed(db);
  return db;
};

/** Insert a row directly, so a state only reachable through a crash can be set up. */
function insertJob(db: ReturnType<typeof dbWithJobs>, status: string, startedAt: number | null): number {
  const r = db.raw
    .prepare("INSERT INTO ai_jobs (kind, status, started_at, attempts, created_at) VALUES ('advisor', ?, ?, 0, ?)")
    .run(status, startedAt, NOW);
  return Number(r.lastInsertRowid);
}

test("jobs: a job abandoned mid-run is claimable again", async () => {
  const db = dbWithJobs();
  // Four minutes in 'running' with nobody attached: an isolate that died before it could write
  // either 'done' or 'failed'. Before the fix this row was invisible to every selector and the
  // kind was disabled for good.
  insertJob(db, "running", NOW - 240);

  assert.equal(await hasQueuedJobs(db as unknown as Env["DB"]), true, "the scheduler must see work to do");

  // `enqueueJob` still returns the same row — idempotency per kind is deliberate and unchanged.
  // What changed is that somebody now executes it.
  const { created } = await enqueueJob(testEnv(db) as unknown as Env, "advisor");
  assert.equal(created, false);
});

test("jobs: a job that is genuinely running is left alone", async () => {
  const db = dbWithJobs();
  // The other side of the same rule. A 30s-old 'running' row is a Sonnet call in flight; claiming
  // it would buy a second generation for one answer — the exact charge `enqueueJob` exists to
  // prevent — and both passes would then race to write the result.
  insertJob(db, "running", NOW - 30);
  assert.equal(await hasQueuedJobs(db as unknown as Env["DB"]), false);
});

test("jobs: a finished job never comes back", async () => {
  const db = dbWithJobs();
  insertJob(db, "done", NOW - 10_000);
  insertJob(db, "failed", NOW - 10_000);
  assert.equal(await hasQueuedJobs(db as unknown as Env["DB"]), false);
  // `runNextJob` returning false is what lets the alarm stop re-arming; a stale 'done' row that
  // still looked like work would keep the object (and the billing) awake forever.
  assert.equal(await runNextJob(testEnv(db) as unknown as Env), false);
});

test("jobs: a fresh queue is claimed in id order", async () => {
  const db = dbWithJobs();
  const first = insertJob(db, "queued", null);
  insertJob(db, "queued", null);
  await runNextJob(testEnv(db) as unknown as Env);
  // No AI key in the harness, so the job fails — the point here is WHICH row was picked up, not
  // what came back from the model.
  const row = db.raw.prepare("SELECT status, attempts FROM ai_jobs WHERE id = ?").get(first) as
    { status: string; attempts: number };
  assert.equal(row.attempts, 1, "the oldest queued job is the one that runs");
  assert.notEqual(row.status, "queued", "and it does not stay queued after a pass");
});
