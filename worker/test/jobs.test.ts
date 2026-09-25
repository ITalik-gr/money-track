/**
 * §A6 — 'running' is a trace that someone claimed the row, not a promise anyone still works on it: an
 * abandoned job must be claimable again, a live one left alone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, testEnv } from "./harness.ts";
import { seed } from "./fixture.ts";
import { enqueueJob, hasQueuedJobs } from "../lib/ai/jobs.ts";
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
