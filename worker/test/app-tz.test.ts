/**
 * §APP_TZ — everything that answers «which day is it» answers the same: buckets, drills and dates
 * handed to or from the model all use the Kyiv expression, not raw UTC.
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

test("the client's month bounds are Kyiv's, whatever zone the browser is in (UI_PASS F2)", async () => {
  // 23:30 UTC on 31 August = 02:30 on 1 September in Kyiv. The client used to build bounds with
  // `new Date(y, m, 1)` in the BROWSER's zone; `shared/time.ts` is what it calls now.
  const { localMonthStart, localParts, daysInMonth } = await import("../../shared/time.ts");
  const lateUtc = Math.floor(Date.parse("2026-08-31T23:30:00Z") / 1000);
  assert.equal(localYm(lateUtc), "2026-09");
  assert.equal(localMonthStart(lateUtc), Math.floor(Date.parse("2026-08-31T21:00:00Z") / 1000));
  assert.equal(localMonthStart(lateUtc, -5), Math.floor(Date.parse("2026-03-31T21:00:00Z") / 1000));
  const p = localParts(lateUtc);
  assert.deepEqual([p.y, p.m, p.d], [2026, 9, 1]);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
});
