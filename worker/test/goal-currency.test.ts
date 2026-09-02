/**
 * §GOAL-CUR — a goal's money has a currency, and it is not the reader's.
 *
 * Written after the owner's own screenshot: «На ланос», backed by a monobank jar he funded in
 * DOLLARS, read «4 480 ₴ з 2 000 ₴ · 100% · Ціль досягнута 🎉» for a goal roughly 5% complete.
 * The jar balance was converted from USD into the display base while the target — a typed figure,
 * therefore stored in hryvnia by §BASE-CUR — was converted from hryvnia. Two conversions, two
 * origins, one comparison: arithmetically consistent and factually wrong.
 *
 * The fixture has no goals at all, which is why none of this was caught: every assertion below is
 * about a row shape the golden suite has never contained.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv, freezeTime } from "./harness.ts";

const USD = 840;
const NOW_ISO = "2026-05-14T09:00:00.000Z";
/** One dollar is worth 40 ₴, i.e. the rate map (expressed in ₴) says 4000 minor per unit. */
const RATES = JSON.stringify({ [USD]: 4000 });

function dbWithDollarJar() {
  const db = migratedDb();
  db.raw.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('rates', ?)").run(RATES);
  db.raw.prepare(
    `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_active, updated_at)
     VALUES ('jar1', 'jar', 'На ланос', ?, 10800, 0, 1, 0)`,
  ).run(USD);   // $108.00 in the jar
  db.raw.prepare(
    `INSERT INTO savings_goals (name, currency_code, target_amount, current_amount, account_id, is_active, created_at)
     VALUES ('На ланос', ?, 200000, 0, 'jar1', 1, 0)`,
  ).run(USD);   // target $2 000
  return db;
}

async function goals(db: ReturnType<typeof migratedDb>, base?: number) {
  const env = base ? { ...testEnv(db), UI_CURRENCY: base } : testEnv(db);
  const res = await api.request("/goals", {}, env);
  return JSON.parse(await res.text()) as { currency_code: number; current: number; target_amount: number; pace: { status: string; progress_frac: number } }[];
}

test("§GOAL-CUR: a dollar jar is measured in dollars, not congratulated in hryvnia", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const db = dbWithDollarJar();
    const [g] = await goals(db);
    assert.equal(g.currency_code, USD);
    // The jar balance is handed over as it stands. $108 of $2 000 is 5% — the old code converted
    // the balance to 4 320 ₴, compared it against a 2 000 target and reported the goal reached.
    assert.equal(g.current, 10800);
    assert.equal(g.target_amount, 200000);
    assert.equal(g.pace.status, "no_deadline");
    assert.equal(Math.round(g.pace.progress_frac * 100), 5);
  } finally { restore(); }
});

test("§GOAL-CUR: the answer does not move when the READER changes currency", async () => {
  // The goal is a pot of dollars whoever is looking at it. A reader on a hryvnia screen sees
  // «$108 з $2 000», not the same money re-priced — re-pricing is what broke the comparison.
  const restore = freezeTime(NOW_ISO);
  try {
    const db = dbWithDollarJar();
    const inUah = await goals(db);
    const inUsd = await goals(db, USD);
    assert.deepEqual(inUsd, inUah);
  } finally { restore(); }
});

test("§GOAL-CUR: a goal with no currency column is hryvnia, as it always was", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const db = migratedDb();
    db.raw.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('rates', ?)").run(RATES);
    // Exactly what migration 0048 leaves behind for a manual goal: `currency_code` NULL.
    db.raw.prepare(
      `INSERT INTO savings_goals (name, target_amount, current_amount, account_id, is_active, created_at)
       VALUES ('Подушка', 5000000, 1250000, NULL, 1, 0)`,
    ).run();
    const [g] = await goals(db);
    assert.equal(g.currency_code, 980);
    assert.equal(g.target_amount, 5000000);   // untouched: it is already hryvnia
    assert.equal(g.current, 1250000);
  } finally { restore(); }
});

test("§GOAL-CUR: a new goal records the jar's currency and stores the typed figure as typed", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const db = dbWithDollarJar();
    db.raw.prepare("DELETE FROM savings_goals").run();
    const res = await api.request("/goals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "На ланос", target_amount: 200000, account_id: "jar1" }),
    }, testEnv(db));
    assert.equal(res.status, 200);
    const row = db.raw.prepare("SELECT currency_code, target_amount FROM savings_goals").get() as { currency_code: number; target_amount: number };
    assert.equal(row.currency_code, USD);
    // NOT divided by the rate. The old write path ran `baseToUah`, which is precisely how «$2 000»
    // became «2 000 ₴» and the goal came to look complete.
    assert.equal(row.target_amount, 200000);
  } finally { restore(); }
});
