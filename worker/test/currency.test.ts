/**
 * §BASE-CUR — which currency the app answers in.
 *
 * The defect this closes is the money half of §LANG-ARCH: the canon converted every multi-currency
 * ledger into ONE unit, and that unit was hardcoded to the hryvnia. So the English UI — which
 * exists for an audience that does not hold hryvnia — showed "146 000 ₴" on every screen, a figure
 * that carries no sense of scale to the person reading it.
 *
 * What makes this worth a test file rather than a code review: the feature works by making forty
 * existing call sites right WITHOUT touching them. `getRates` kept its name and its return type,
 * and simply started answering in the reader's base. That is what made the change tractable, and
 * it is exactly what makes a regression invisible — the wrong version compiles, runs, and renders
 * a plausible number. `tsc` cannot tell two `Record<string, number>` maps apart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, testEnv } from "./harness.ts";
import { seed } from "./fixture.ts";
import { api } from "../routes/api/index.ts";
import {
  getRates, resolveBaseCurrency, ratesInBase, toBaseMinor, uahToBase, baseToUah, hryvniaMult,
} from "../lib/finance/money.ts";
import { baseMult } from "../lib/finance/stats.ts";
import { renderNotif } from "../../shared/notif-i18n.ts";
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

test("base currency: amounts STORED in hryvnia round-trip through the base", () => {
  const usd = ratesInBase(STORED, USD);
  assert.equal(uahToBase(usd), 1 / 40);
  // A budget limit typed as $200 is stored as ₴8 000 and reads back as $200.
  assert.equal(baseToUah(200_00, usd), 8000_00);
  assert.equal(Math.round(8000_00 * uahToBase(usd)), 200_00);
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

test("base currency: /rates answers in the base it could actually honour", async () => {
  const d = db();
  const res = await api.request("/rates", {}, env(d, { UI_CURRENCY: USD }));
  const body = await res.json() as { base: number; rates: Record<string, number> };
  assert.equal(body.base, USD);
  assert.equal(body.rates["840"], 1);

  // And when the rate is missing, it says 980 rather than letting the client print "$".
  d.raw.prepare("DELETE FROM app_state WHERE key = 'rates'").run();
  const res2 = await api.request("/rates", {}, env(d, { UI_CURRENCY: USD }));
  assert.equal(((await res2.json()) as { base: number }).base, 980);
});

test("base currency: a stored notification carries the unit its numbers were computed in", () => {
  // The feed renders numbers written months ago. Re-labelling them with today's currency would
  // put the sign of one currency in front of the amount of another — a lie that renders perfectly.
  const withCur = renderNotif("en", "budget", { name: "Groceries", pct: 90, spent: 100_00, amount: 110_00, cur: USD });
  assert.ok(withCur.title.includes("Groceries"));
  assert.ok(JSON.stringify(withCur).includes("$"), JSON.stringify(withCur));

  // A row written before the setting existed has no `cur` and is hryvnia by construction.
  const legacy = renderNotif("uk", "budget", { name: "Продукти", pct: 90, spent: 100_00, amount: 110_00 });
  assert.ok(JSON.stringify(legacy).includes("₴"), JSON.stringify(legacy));
});

test("base currency: an envelope limit is compared against spending in the SAME unit", async () => {
  // The limit is stored in hryvnia and the spend is rolled up by the canon. Un-converted, the
  // ratio would be wrong by the exchange rate — not a rounding error but a different answer.
  const d = db();
  const { budgetStatus } = await import("../lib/finance/budgets.ts");
  const { valueMode } = await import("../lib/finance/stats.ts");

  const uahRates = await getRates(env(d));
  const usdRates = await getRates(env(d, { UI_CURRENCY: USD }));
  const inUah = await budgetStatus(env(d), valueMode(uahRates, null).mult);
  const inUsd = await budgetStatus(env(d, { UI_CURRENCY: USD }), valueMode(usdRates, null).mult);
  assert.ok(inUah.length > 0, "the fixture must seed envelopes, or this test proves nothing");

  for (const [i, row] of inUah.entries()) {
    // Same percentage, different unit: that is the whole promise of a display currency.
    assert.ok(Math.abs(row.ratio - inUsd[i].ratio) < 0.001, `${row.name}: ${row.ratio} vs ${inUsd[i].ratio}`);
    assert.ok(inUsd[i].amount < row.amount, "a dollar limit must be a smaller number than a hryvnia one");
  }
});
