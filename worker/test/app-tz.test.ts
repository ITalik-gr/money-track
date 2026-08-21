/**
 * §APP_TZ — everything that answers «який це день» must answer the same thing.
 *
 * The rule has been in CLAUDE.md since 2026-08-01, when Statistics showed JULY at 02:46 on the 1st
 * of August. What that fix covered was the period BOUNDS. A sweep on 2026-08-21 found the rule had
 * never reached the buckets INSIDE those bounds, the drill dimensions behind them, two counters,
 * two heuristics and everything the model is told about time — nine places, all of which render a
 * plausible number and none of which fails.
 *
 * These tests pin the shape of the mistake rather than one instance of it: a local expression is
 * offset from the raw UTC one, and every calendar dimension has to use the same expression as the
 * chart it belongs to.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { localFmtSql, localYmSql, localYmd, localYm, localWallTime, tzOffsetSec } from "../lib/finance/time.ts";

/** 2026-08-01 00:30 Kyiv = 2026-07-31 21:30 UTC — the window the old code got wrong. */
const AFTER_MIDNIGHT_KYIV = Math.floor(Date.parse("2026-07-31T21:30:00Z") / 1000);

test("the local day key is the reader's day, not the runtime's", () => {
  // The single fact behind every bug in this sweep.
  assert.equal(new Date(AFTER_MIDNIGHT_KYIV * 1000).toISOString().slice(0, 10), "2026-07-31");
  assert.equal(localYmd(AFTER_MIDNIGHT_KYIV), "2026-08-01");
  assert.equal(localYm(AFTER_MIDNIGHT_KYIV), "2026-08");
});

test("localFmtSql carries the offset into ANY bucket, not just the month", () => {
  const off = tzOffsetSec(AFTER_MIDNIGHT_KYIV);
  assert.ok(off > 0, "Kyiv is ahead of UTC");
  // Each of these replaced a raw `strftime` somewhere: the chart series, the weekday drill, the
  // day-of-month drill, the recurring-merchant heuristic.
  for (const fmt of ["%Y-%m-%d", "%Y-W%W", "%w", "%d", "%Y-%m"]) {
    assert.equal(localFmtSql(AFTER_MIDNIGHT_KYIV, fmt), `strftime('${fmt}', t.time + ${off}, 'unixepoch')`);
  }
  // `localYmSql` is now one call into it, so the two can never drift apart again.
  assert.equal(localYmSql(AFTER_MIDNIGHT_KYIV), localFmtSql(AFTER_MIDNIGHT_KYIV, "%Y-%m"));
});

test("localFmtSql takes the column, so a subquery without the `t` alias still works", () => {
  // `recurringMerchantsSubquery` selects from `transactions` unaliased; passing the default `t.time`
  // there is a runtime SQL error, not a type error, so the parameter is load-bearing.
  assert.ok(localFmtSql(AFTER_MIDNIGHT_KYIV, "%Y-%m", "time").includes("time + "));
  assert.ok(!localFmtSql(AFTER_MIDNIGHT_KYIV, "%Y-%m", "time").includes("t.time"));
});

test("a bare date from the model is a KYIV wall clock", () => {
  // The rule §BANK-PARSE already states for a CSV, applied to the chat tools: with `Date.UTC` the
  // boundary of "August" sat at 03:00 Kyiv, so the model's total and the screen's disagreed by
  // whatever was spent in those three hours.
  const start = localWallTime(2026, 8, 1, 0, 0, 0);
  assert.equal(localYmd(start), "2026-08-01");
  assert.equal(new Date(start * 1000).toISOString(), "2026-07-31T21:00:00.000Z");
  const end = localWallTime(2026, 8, 31, 23, 59, 59);
  assert.equal(localYmd(end), "2026-08-31");
  // The whole month, and nothing of September.
  assert.ok(end - start > 30 * 86400 && end - start < 31 * 86400 + 3600);
});

test("summer and winter offsets are each resolved at their own instant", () => {
  const summer = tzOffsetSec(Math.floor(Date.parse("2026-07-15T12:00:00Z") / 1000));
  const winter = tzOffsetSec(Math.floor(Date.parse("2026-01-15T12:00:00Z") / 1000));
  assert.equal(summer, 3 * 3600);
  assert.equal(winter, 2 * 3600);
  // A single hardcoded offset would be wrong for half the year — which is why the helpers take
  // `now` rather than a constant.
  assert.notEqual(summer, winter);
});

/**
 * The end-to-end half: an evening purchase, through the real endpoints.
 *
 * The unit tests above prove the EXPRESSION is offset. They cannot prove it reached the chart, the
 * drill and the weekday split — which is exactly what had gone wrong: `localYmSql` existed and was
 * correct for two years' worth of month keys while three other buckets sat one zone away from it.
 */
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed } from "./fixture.ts";

/** 21:30 UTC on 12 May 2026 = 00:30 Kyiv on the 13th — a Wednesday, not a Tuesday. */
const EVENING_UTC = Math.floor(Date.parse("2026-05-12T21:30:00Z") / 1000);

function withEveningTx(): MemDb {
  const db = migratedDb();
  seed(db);
  db.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, currency_code, time, amount, merchant, category_id, hold, is_transfer)
     VALUES ('tz-late', 'acc-uah', 'mono', 980, ?, -123400, 'Nightshop', 1, 0, 0)`,
  ).run(EVENING_UTC);
  return db;
}

const get = async (db: MemDb, path: string) =>
  JSON.parse(await (await api.request(path, {}, testEnv(db))).text());

test("a purchase after 21:00 Kyiv lands on the day the reader spent it", async () => {
  const restore = freezeTime("2026-05-14T09:00:00.000Z");
  try {
    // Against a CONTROL, because the fixture already spends on both days — the question is which
    // bar GREW, not which bar is non-zero.
    const control = migratedDb(); seed(control);
    const bucketsOf = async (db: MemDb) => new Map<string, number>(
      (await get(db, "/analytics/overview?preset=month")).series
        .map((s: { bucket: string; spend: number }) => [s.bucket, s.spend]),
    );
    const before = await bucketsOf(control);
    const after = await bucketsOf(withEveningTx());

    // The purchase belongs to the 13th. In UTC it was drawn on the 12th — one bar to the left of
    // where the person remembers making it, and on the 1st of a month, one bar into the PREVIOUS
    // month, which is how a period could open with spending that predates it.
    assert.equal((after.get("2026-05-13") ?? 0) - (before.get("2026-05-13") ?? 0), 123400);
    assert.equal((after.get("2026-05-12") ?? 0) - (before.get("2026-05-12") ?? 0), 0);
  } finally { restore(); }
});

test("the day drill opens the SAME set of rows the bar was drawn from", async () => {
  const restore = freezeTime("2026-05-14T09:00:00.000Z");
  try {
    const db = withEveningTx();
    const to = Math.floor(Date.parse("2026-05-14T09:00:00Z") / 1000);
    const from = to - 30 * 86400;
    const drill = await get(db, `/analytics/slice?dim=day&value=2026-05-13&from=${from}&to=${to}`);
    // The bug this pins: bar and list disagreeing looks like the app losing a transaction, which
    // is the single worst thing a ledger can appear to do.
    assert.ok(drill.transactions.some((t: { id: string }) => t.id === "tz-late"));
  } finally { restore(); }
});

test("the weekday split files it on Wednesday, and its drill agrees", async () => {
  const restore = freezeTime("2026-05-14T09:00:00.000Z");
  try {
    const db = withEveningTx();
    const to = Math.floor(Date.parse("2026-05-14T09:00:00Z") / 1000);
    const from = to - 30 * 86400;
    const wd = await get(db, `/analytics/weekday?from=${from}&to=${to}`);
    const tue = wd.days.find((d: { dow: number }) => d.dow === 2);
    const wed = wd.days.find((d: { dow: number }) => d.dow === 3);
    assert.ok(wed.spent >= 123400, "Wednesday holds it");

    const drill = await get(db, `/analytics/slice?dim=weekday&value=3&from=${from}&to=${to}`);
    assert.ok(drill.transactions.some((t: { id: string }) => t.id === "tz-late"));
    // And Tuesday's own drill must not also claim it — double counting is the other failure mode.
    const tueDrill = await get(db, `/analytics/slice?dim=weekday&value=2&from=${from}&to=${to}`);
    assert.ok(!tueDrill.transactions.some((t: { id: string }) => t.id === "tz-late"));
    assert.ok(tue.spent >= 0);
  } finally { restore(); }
});

/**
 * The export/import ROUND TRIP, which is where a date convention stops being a preference.
 *
 * §BANK-PARSE settled that a zone-less date in a statement is a Kyiv wall clock — a statement is
 * written in local time. The CSV EXPORT then wrote UTC, so exporting and re-importing moved every
 * purchase made after 21:00 Kyiv back by a day, and the totals still added up.
 */
import { localWallTime as wall } from "../lib/finance/time.ts";

test("a date exported and re-imported is the same date", () => {
  // 00:30 Kyiv on the 13th — the window where the two conventions disagree.
  const at = Math.floor(Date.parse("2026-05-12T21:30:00Z") / 1000);

  const exported = localYmd(at);                      // what the CSV now writes
  assert.equal(exported, "2026-05-13");
  assert.notEqual(exported, new Date(at * 1000).toISOString().slice(0, 10), "UTC would say the 12th");

  // What the importer makes of it (§BANK-PARSE: a bare date is a Kyiv wall clock).
  const [y, m, d] = exported.split("-").map(Number);
  const reimported = wall(y, m, d, 0, 0, 0);
  assert.equal(localYmd(reimported), exported, "the round trip lands on the same day");
});
