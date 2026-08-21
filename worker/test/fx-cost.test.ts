/**
 * §FX-COST — the conversion fee that appears on no statement.
 *
 * Two ways this can be wrong, and both produce a plausible number rather than an error:
 *
 *  1. Valuing the purchase at TODAY's rate. Then every month the hryvnia moved becomes a "fee",
 *     and the figure grows with time rather than with the bank's markup. This is why the whole
 *     calculation goes through `rate_history` instead of the live table.
 *  2. Filling a missing day from the current rate. Same failure, quieter: one row, one day, and
 *     the reader has no way to know which figure was invented.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeFxCost, type ForeignTx } from "../lib/finance/fx.ts";
import type { Rates } from "../lib/finance/money.ts";

const EUR = 978, USD = 840, UAH = 980;
const dayKey = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const at = (day: string) => Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000);

const tx = (o: Partial<ForeignTx> & { time: number; amount: number; original_amount: number; original_currency: number }): ForeignTx => ({
  id: `t${o.time}-${o.original_currency}`, merchant: "shop", currency_code: UAH, ...o,
});

/** ₴ per unit, the shape `rate_history` stores. */
const days = (m: Record<string, Rates>) => new Map(Object.entries(m));

test("a fair conversion costs nothing", () => {
  // €100 charged as ₴5 000 on a day the euro was worth ₴50 — exactly the published rate.
  const r = computeFxCost(
    [tx({ time: at("2026-05-01"), amount: -500000, original_amount: -10000, original_currency: EUR })],
    days({ "2026-05-01": { [EUR]: 50 } }), dayKey, 1,
  );
  assert.equal(r.n, 1);
  assert.equal(r.cost, 0);
  assert.equal(r.cost_pct, 0);
});

test("the markup is the gap between the applied rate and the published one", () => {
  // €100 charged as ₴5 150 on a ₴50 day: 3% over.
  const r = computeFxCost(
    [tx({ time: at("2026-05-01"), amount: -515000, original_amount: -10000, original_currency: EUR })],
    days({ "2026-05-01": { [EUR]: 50 } }), dayKey, 1,
  );
  assert.equal(r.charged, 515000);
  assert.equal(r.market, 500000);
  assert.equal(r.cost, 15000);
  assert.equal(r.cost_pct, 3);
});

test("each purchase is valued at the rate of ITS OWN day", () => {
  // Same €100 twice, both at a fair rate — but the euro rose from 50 to 60 in between. Using one
  // rate for both would report ₴1 000 of "fee" for a currency move, which is the failure this
  // whole module is arranged to avoid.
  const r = computeFxCost(
    [
      tx({ time: at("2026-04-01"), amount: -500000, original_amount: -10000, original_currency: EUR }),
      tx({ time: at("2026-05-01"), amount: -600000, original_amount: -10000, original_currency: EUR }),
    ],
    days({ "2026-04-01": { [EUR]: 50 }, "2026-05-01": { [EUR]: 60 } }), dayKey, 1,
  );
  assert.equal(r.n, 2);
  assert.equal(r.cost, 0);
});

test("a day with no published rate is DROPPED and counted, never approximated", () => {
  const r = computeFxCost(
    [
      tx({ time: at("2026-05-01"), amount: -515000, original_amount: -10000, original_currency: EUR }),
      tx({ time: at("2026-05-02"), amount: -515000, original_amount: -10000, original_currency: EUR }),
    ],
    days({ "2026-05-01": { [EUR]: 50 } }), dayKey, 1,
  );
  assert.equal(r.n, 1);
  assert.equal(r.unpriced, 1);
  // The total describes the row it could price, and says so. Half a fee reported honestly beats
  // a whole one where half is invented.
  assert.equal(r.cost, 15000);
});

test("a non-hryvnia ACCOUNT converts through the published rate too", () => {
  // A dollar card charged in euro: $110 for €100 on a day when €1 = ₴50 and $1 = ₴40.
  // Fair would be $125, so this is a bank rate BETTER than the published one — and the sign has
  // to survive, because a negative cost is a real thing and clamping it would only ever flatter.
  const r = computeFxCost(
    [tx({ time: at("2026-05-01"), amount: -11000, currency_code: USD, original_amount: -10000, original_currency: EUR })],
    days({ "2026-05-01": { [EUR]: 50, [USD]: 40 } }), dayKey, 1,
  );
  assert.equal(r.charged, 440000);   // $110 × ₴40
  assert.equal(r.market, 500000);    // €100 × ₴50
  assert.equal(r.cost, -60000);
});

test("currencies are grouped, and the worst-cost rows lead", () => {
  const r = computeFxCost(
    [
      // A 6% markup on a small coffee: loud in percent, trivial in money.
      tx({ time: at("2026-05-01"), amount: -5300, original_amount: -100, original_currency: EUR }),
      // A 2% markup on a hotel: the one worth acting on.
      tx({ time: at("2026-05-01"), amount: -1020000, original_amount: -25000, original_currency: USD }),
    ],
    days({ "2026-05-01": { [EUR]: 50, [USD]: 40 } }), dayKey, 1,
  );
  assert.deepEqual(r.by_currency.map((x) => x.code), [USD, EUR]);
  assert.equal(r.items[0].original_currency, USD);
});

test("§BASE-CUR: the answer arrives in the reader's base", () => {
  // The comparison happens in hryvnia (where the published rates live) and converts ONCE.
  const rows = [tx({ time: at("2026-05-01"), amount: -515000, original_amount: -10000, original_currency: EUR })];
  const d = days({ "2026-05-01": { [EUR]: 50 } });
  assert.equal(computeFxCost(rows, d, dayKey, 1).cost, 15000);
  assert.equal(computeFxCost(rows, d, dayKey, 0.5).cost, 7500);
  // A percentage is a ratio, so it must NOT move with the base.
  assert.equal(computeFxCost(rows, d, dayKey, 0.5).cost_pct, 3);
});

test("no foreign purchases is an empty answer, not a zero fee", () => {
  const r = computeFxCost([], days({}), dayKey, 1);
  assert.equal(r.n, 0);
  // `null`, not 0: «0% націнки» claims the bank charged fairly, which nothing here established.
  assert.equal(r.cost_pct, null);
});
