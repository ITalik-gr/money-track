/**
 * §BASE-CUR — which currency the app answers in. `getRates` answers in the reader's base, so forty
 * call sites convert without being touched; these pin the pieces that make that true.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, testEnv } from "./harness.ts";
import { seed } from "./fixture.ts";
import {
   resolveBaseCurrency, ratesInBase, toBaseMinor, hryvniaMult,
} from "../lib/finance/money.ts";
import { baseMult } from "../lib/finance/stats.ts";
import type { Env } from "../env.ts";

const USD = 840;
const STORED = { "840": 40, "978": 45 };      // as the fixture seeds them: ₴ per unit

const db = () => { const d = migratedDb(); seed(d); return d; };
const env = (d: ReturnType<typeof db>, extra: Record<string, unknown> = {}) =>
  ({ ...testEnv(d), ...extra }) as unknown as Env;

// ---- the re-expression itself ------------------------------------------------

test("base currency: the stored table gains a 980 row and is divided by the base", () => {
  const uah = ratesInBase(STORED, 980);
  // The 980 entry is what lets `baseMult`/`toBaseMinor` stop special-casing the hryvnia.
  assert.equal(uah["980"], 1);
  assert.equal(uah["840"], 40);

  const usd = ratesInBase(STORED, USD);
  assert.equal(usd["840"], 1);
  assert.equal(usd["980"], 1 / 40);
  assert.equal(usd["978"], 45 / 40);
});

test("base currency: a base we have no rate for falls back to hryvnia, it does not divide by zero", () => {
  // 0 or Infinity would turn every number on every screen into nonsense that still renders.
  const out = ratesInBase({ "978": 45 }, USD);
  assert.equal(out["980"], 1);
  assert.equal(out["978"], 45);
});

test("base currency: resolveBaseCurrency refuses a base it cannot convert into", async () => {
  const d = db();
  d.raw.prepare("DELETE FROM app_state WHERE key = 'rates'").run();
  // Asked for dollars, has no rate — answering "840" would print $ over hryvnia figures, which is
  // strictly worse than printing ₴.
  assert.equal(await resolveBaseCurrency(env(d, { UI_CURRENCY: USD })), 980);
});

test("base currency: the reader beats the stored choice, which beats the language", async () => {
  const d = db();
  d.raw.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('display_currency', '978')").run();
  assert.equal(await resolveBaseCurrency(env(d, { UI_CURRENCY: USD })), USD);
  assert.equal(await resolveBaseCurrency(env(d)), 978);

  d.raw.prepare("DELETE FROM app_state WHERE key = 'display_currency'").run();
  // No choice at all: the language decides, because the English UI exists for readers who do not
  // hold hryvnia. This is the case that made every demo visitor see ₴.
  assert.equal(await resolveBaseCurrency(env(d, { UI_LOCALE: "en" })), USD);
  assert.equal(await resolveBaseCurrency(env(d, { UI_LOCALE: "uk" })), 980);
});

// ---- the seam every sum passes through ---------------------------------------

test("base currency: the SQL multiplier converts hryvnia rows too", async () => {
  const usd = ratesInBase(STORED, USD);
  const mult = baseMult(usd);
  assert.ok(mult.includes("WHEN 980 THEN 0.025"), mult);
  assert.ok(mult.includes("WHEN 840 THEN 1"), mult);

  // …and a RAW map (or an empty one, on an account whose rates step never ran) still gets its
  // hryvnia arm. Without it every hryvnia row would fall to the ELSE branch — zero — and the whole
  // ledger would read as an empty account.
  assert.ok(baseMult(STORED).includes("WHEN 980 THEN 1.0"));
  assert.ok(baseMult({}).includes("WHEN 980 THEN 1.0"));
});

test("base currency: the JS conversion agrees with the SQL one", () => {
  const usd = ratesInBase(STORED, USD);
  assert.equal(toBaseMinor(4000_00, 980, usd), 100_00);   // ₴4 000 → $100
  assert.equal(toBaseMinor(100_00, 840, usd), 100_00);    // a dollar row is already in base
  assert.equal(toBaseMinor(100_00, 999, usd), 0);         // unknown currency contributes nothing
});

test("base currency: a CLOSED month is written in hryvnia, whoever triggered the cron", async () => {
  // `budget_months` is an archive. If it were written with the reader's multiplier, the history
  // would say dollars for the months a dollar reader happened to be the first visitor that day,
  // and hryvnia for the rest — a series whose unit changes under it.
  const d = db();
  const mult = await hryvniaMult(env(d, { UI_CURRENCY: USD }));
  assert.ok(mult.includes("WHEN 980 THEN 1.0"), mult);
  assert.ok(!mult.includes("0.025"), mult);
});

// ---- what the reader ends up seeing ------------------------------------------
