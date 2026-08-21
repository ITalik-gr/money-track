/**
 * What conversion actually COST — the number no bank statement contains.
 *
 * A card payment abroad arrives with both halves already stored: `original_amount` in the currency
 * the shop charged, and `amount` in the currency of the account the money left. Their ratio is the
 * rate the bank ACTUALLY applied. `rate_history` (migration 0024) holds what the rate was that
 * day. The difference between the two is a fee, and it is the only fee in the whole application
 * that is never written on a line of its own — it is folded into the price of a coffee.
 *
 * Every input the calculation needs has been in the database since 2026-07. Nothing read it.
 *
 * ⚠️ **The comparison is done in HRYVNIA and converted once at the end** (§BASE-CUR). Both sides
 * are valued at the market rate OF THEIR DAY, so a rate that moved between the purchase and today
 * cannot show up as a bank markup — which is the mistake this analysis exists to avoid making, and
 * the reason it needs `rate_history` rather than the current rate table.
 *
 * ⚠️ **A day with no rate for either currency is SKIPPED, never approximated.** Falling back on
 * today's rate would silently turn months of currency movement into a fee, and a fabricated fee
 * reads exactly like a real one. The count of skipped rows is reported instead.
 */
import type { Rates } from "./money.ts";

export interface ForeignTx {
  id: string; time: number; merchant: string | null;
  amount: number; currency_code: number;
  original_amount: number; original_currency: number;
}

export interface FxItem {
  id: string; at: number; merchant: string | null;
  original_amount: number; original_currency: number;
  /** What the account was actually charged, converted into the reader's base. */
  charged: number;
  /** What it was worth at the published rate of that day, same base. */
  market: number;
  cost: number;
  cost_pct: number;
}

export interface FxByCurrency {
  code: number; n: number; charged: number; market: number; cost: number; cost_pct: number;
}

export interface FxCostResult {
  n: number;
  charged: number;
  market: number;
  cost: number;
  /** Markup as a share of the market value, or `null` when nothing could be priced. */
  cost_pct: number | null;
  /** Rows dropped because no published rate was available for their day. */
  unpriced: number;
  by_currency: FxByCurrency[];
  items: FxItem[];
}

/** ₴ per one unit of `code` on that day; the hryvnia is the unit, so it is 1 by definition. */
function rateOf(rates: Rates | undefined, code: number): number | null {
  if (code === 980) return 1;
  const r = rates?.[String(code)];
  return Number.isFinite(r) && (r as number) > 0 ? (r as number) : null;
}

export function computeFxCost(
  rows: ForeignTx[],
  ratesByDay: Map<string, Rates>,
  dayKey: (unix: number) => string,
  uahToBaseRate: number,
  topN = 8,
): FxCostResult {
  const inBase = (uahMinor: number) => Math.round(uahMinor * uahToBaseRate);
  const byCur = new Map<number, { n: number; charged: number; market: number }>();
  const items: FxItem[] = [];
  let charged = 0, market = 0, unpriced = 0, n = 0;

  for (const r of rows) {
    const day = ratesByDay.get(dayKey(r.time));
    const rAcc = rateOf(day, r.currency_code);
    const rOp = rateOf(day, r.original_currency);
    if (rAcc == null || rOp == null) { unpriced++; continue; }

    // Both sides in hryvnia minor units. Rates are ₴ per unit and both currencies are stored in
    // hundredths, so a minor amount times a rate is already ₴ minor — the same shortcut `uahMult`
    // takes in SQL.
    const chargedUah = Math.abs(r.amount) * rAcc;
    const marketUah = Math.abs(r.original_amount) * rOp;
    if (marketUah <= 0) { unpriced++; continue; }

    n++;
    charged += chargedUah;
    market += marketUah;
    const agg = byCur.get(r.original_currency) ?? { n: 0, charged: 0, market: 0 };
    agg.n++; agg.charged += chargedUah; agg.market += marketUah;
    byCur.set(r.original_currency, agg);

    items.push({
      id: r.id, at: r.time, merchant: r.merchant,
      original_amount: r.original_amount, original_currency: r.original_currency,
      charged: inBase(chargedUah), market: inBase(marketUah),
      cost: inBase(chargedUah - marketUah),
      cost_pct: Math.round(((chargedUah - marketUah) / marketUah) * 1000) / 10,
    });
  }

  return {
    n,
    charged: inBase(charged),
    market: inBase(market),
    cost: inBase(charged - market),
    cost_pct: market > 0 ? Math.round(((charged - market) / market) * 1000) / 10 : null,
    unpriced,
    by_currency: [...byCur.entries()]
      .map(([code, v]) => ({
        code, n: v.n, charged: inBase(v.charged), market: inBase(v.market),
        cost: inBase(v.charged - v.market),
        cost_pct: Math.round(((v.charged - v.market) / v.market) * 1000) / 10,
      }))
      .sort((a, b) => b.cost - a.cost),
    // Ranked by what it COST, not by how big the purchase was: a 2% markup on a hotel is worth
    // more attention than a 6% markup on a coffee, and the reader can only act on the first.
    items: items.sort((a, b) => b.cost - a.cost).slice(0, topN),
  };
}
