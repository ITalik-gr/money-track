/**
 * §APP_TZ at the month boundary, on the endpoint that mixes a JS month key with a SQL one.
 *
 * `/analytics/patterns` reads «what has this category spent THIS month» out of a matrix grouped in
 * SQL by the Kyiv month (`localYmSql`), using a key built in JavaScript. Those two have to be the
 * same calendar. Between 00:00 and 03:00 Kyiv on the first of a month they are not, if the key is
 * built with `toISOString()` — and the endpoint then answers with LAST month's total as this
 * month's spending, while the same month also appears among the six trailing months it is being
 * compared against.
 *
 * Three hours a month, on the one morning a fresh month should read as nearly empty. That is the
 * §APP_TZ failure exactly: a plausible number, from an honest calculation, in the wrong calendar.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import type { SpendPatterns } from "../../shared/api/analytics.ts";

/** 1 August 2026, 00:30 in Kyiv — still 31 July in UTC. */
const NIGHT_ISO = "2026-07-31T21:30:00.000Z";

function db(): MemDb {
  const d = migratedDb();
  d.raw.prepare(
    "INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit) VALUES (?,?,?,?,?,?)",
  ).run("acc", "black", "Картка", 980, 0, 0);
  const put = (id: string, iso: string, amount: number) => d.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, category_id, merchant)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, "acc", "mono", Math.floor(Date.parse(iso) / 1000), amount, 980, 1, "Крамниця");

  // A full July of groceries, Kyiv time.
  for (let day = 1; day <= 20; day++) {
    put(`jul-${day}`, `2026-07-${String(day).padStart(2, "0")}T10:00:00.000Z`, -1_000_00);
  }
  // And one small purchase half an hour into August, Kyiv time.
  put("aug-1", "2026-07-31T21:20:00.000Z", -150_00);
  return d;
}

test("§APP_TZ: at 00:30 Kyiv on the 1st, «this month» is the NEW month", async () => {
  const restore = freezeTime(NIGHT_ISO);
  try {
    const d = db();
    const res = await api.request("/analytics/patterns", { method: "GET" }, testEnv(d));
    assert.equal(res.status, 200);
    const body = await res.json() as SpendPatterns;
    const groceries = body.pace.find((p) => p.spent > 0);
    assert.ok(groceries, "the August purchase is this month's spending");
    assert.equal(groceries!.spent, 150_00,
      "150 ₴ — not the 20 000 ₴ of July, which is what a UTC key would have returned");
  } finally { restore(); }
});
