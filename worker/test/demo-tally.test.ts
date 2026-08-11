/**
 * The demo tally — "how many people who had never seen this app opened it".
 *
 * It is the only number in the product that measures the OUTSIDE world, and it is read to make a
 * judgement ("is this worth continuing"). That makes a wrong number worse than no number, and it
 * has exactly two ways to go wrong: counting somebody who is not a stranger, and counting one
 * stranger more than once.
 *
 * SCOPE, stated plainly because the gap matters: this covers what the route DELEGATES here — the
 * day key, the increment, the correction. The two decisions the route makes itself are NOT covered
 * and cannot be from a unit test: it returns early on a valid demo cookie (so a reload inside 24h
 * is not a second visit), and it skips the count entirely for a signed-in visitor. `GET /demo`
 * needs the Durable Object binding, an R2 bucket and a live seed, so both are held by reading the
 * route rather than by an assertion.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDirectoryDb, freezeTime, type MemDb } from "./harness.ts";
import { recordDemoVisit, discountDemoVisits, demoVisits } from "../lib/platform/feedback.ts";

/** `recordDemoVisit` takes an `Env` only to reach `DIRECTORY`. */
const envOf = (db: MemDb) => ({ DIRECTORY: db }) as never;
/** The shim implements the slice of D1 these functions use; its SHAPE is not the full interface. */
const d1 = (db: MemDb) => db as unknown as D1Database;

const day = (db: MemDb, d: string) =>
  db.raw.prepare("SELECT sandboxes FROM demo_daily WHERE day = ?").get(d) as { sandboxes: number } | undefined;

test("demo tally: one row per Kyiv day, counted up", async () => {
  const db = migratedDirectoryDb();
  // 14 May 2026, 09:00 UTC = midday in Kyiv.
  const restore = freezeTime("2026-05-14T09:00:00.000Z");
  try {
    await recordDemoVisit(envOf(db));
    await recordDemoVisit(envOf(db));
    await recordDemoVisit(envOf(db));
    assert.equal(day(db, "2026-05-14")?.sandboxes, 3);
    assert.equal((await demoVisits(d1(db))).length, 1, "three visits on one day are one row");
  } finally { restore(); }
});

test("demo tally: the day boundary is Kyiv's, not UTC's", async () => {
  const db = migratedDirectoryDb();
  // 22:30 UTC on 14 May is 01:30 on 15 May in Kyiv. Counting this as the 14th would put late-night
  // visits on the previous day — the same §APP_TZ bug that once made the whole app a day behind
  // between midnight and 03:00, and here it would smear a launch across two rows.
  const restore = freezeTime("2026-05-14T22:30:00.000Z");
  try {
    await recordDemoVisit(envOf(db));
    assert.equal(day(db, "2026-05-15")?.sandboxes, 1);
    assert.equal(day(db, "2026-05-14"), undefined);
  } finally { restore(); }
});

test("demo tally: subtracting the owner's own visits", async () => {
  const db = migratedDirectoryDb();
  const restore = freezeTime("2026-05-14T09:00:00.000Z");
  try {
    for (let i = 0; i < 4; i++) await recordDemoVisit(envOf(db));

    await discountDemoVisits(d1(db), "2026-05-14");
    assert.equal(day(db, "2026-05-14")?.sandboxes, 3, "one press removes exactly one visit");

    await discountDemoVisits(d1(db), "2026-05-14", 2);
    assert.equal(day(db, "2026-05-14")?.sandboxes, 1);

    // A day that reaches zero disappears: "0 visits" and "no visits recorded" are the same fact,
    // and the list is a log of days that happened. A zero row would read as a day the demo was
    // broken.
    await discountDemoVisits(d1(db), "2026-05-14");
    assert.equal(day(db, "2026-05-14"), undefined);
    assert.equal((await demoVisits(d1(db))).length, 0);
  } finally { restore(); }
});

test("demo tally: subtracting more than a day holds cannot go negative", async () => {
  const db = migratedDirectoryDb();
  const restore = freezeTime("2026-05-14T09:00:00.000Z");
  try {
    await recordDemoVisit(envOf(db));
    await discountDemoVisits(d1(db), "2026-05-14", 50);
    // The row is gone rather than sitting at -49. A negative count would survive into the bar
    // chart, where the day's width is a share of the peak.
    assert.equal(day(db, "2026-05-14"), undefined);
  } finally { restore(); }
});

test("demo tally: an unknown day is a no-op, not an error", async () => {
  const db = migratedDirectoryDb();
  // The owner can press the button on a day that another tab already cleared. Doing nothing is the
  // honest outcome; throwing would surface as a toast about a statistic.
  await discountDemoVisits(d1(db), "2026-01-01");
  assert.equal((await demoVisits(d1(db))).length, 0);
});

test("demo tally: days come back newest first, and only days with visits", async () => {
  const db = migratedDirectoryDb();
  for (const iso of ["2026-05-10T09:00:00.000Z", "2026-05-12T09:00:00.000Z", "2026-05-14T09:00:00.000Z"]) {
    const restore = freezeTime(iso);
    try { await recordDemoVisit(envOf(db)); } finally { restore(); }
  }
  const days = await demoVisits(d1(db));
  assert.deepEqual(days.map((d) => d.day), ["2026-05-14", "2026-05-12", "2026-05-10"]);
  // 11 and 13 May are absent rather than zero — the chart draws the days that happened.
  assert.equal(days.length, 3);
});
