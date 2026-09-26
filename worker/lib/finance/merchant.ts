// §P3 — the merchant page: one merchant, both directions of money.
//
// In `lib/` rather than in the handler for the same reason as `networth.ts`: deciding what the
// page SAYS (which side leads, how regular the payments are, the gap-filled year) is feature logic,
// and it was the route file's size that forced the move. The numbers themselves come from the
// canon via `repo/merchant.ts` — spend through `SPEND_WHERE`, income through `INCOME_WHERE`.
import type { Env } from "../../env.ts";
import type { MerchantAnalytics, MerchantSide } from "../../../shared/api/analytics.ts";
import type { NotifLocale } from "../../../shared/notif-i18n.ts";
import * as merchantRepo from "../../repo/merchant.ts";
import type { MerchantSideKey } from "../../repo/merchant.ts";
import { getRates } from "./money.ts";
import { valueMode, localMonthStart, localYm } from "./stats.ts";

const MONTHS = 12;
const TX_LIMIT = 60;

/** Median gap between consecutive operations, in whole days. Median, not mean: one skipped
 *  month would otherwise turn a monthly salary into "every 45 days". */
function medianGapDays(times: number[]): number | null {
  if (times.length < 3) return null;
  const gaps = times.slice(1).map((t, i) => (t - times[i]) / 86400).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const med = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.max(1, Math.round(med));
}

async function side(
  env: Env, locale: NotifLocale, mult: string, name: string, key: MerchantSideKey,
  total: number, n: number, first: number | null, last: number | null,
): Promise<MerchantSide> {
  if (n === 0 && total === 0) {
    return { total: 0, n: 0, avg: 0, first_at: null, last_at: null, every_days: null, top_category: null, category_share: null };
  }
  const db = env.DB;
  const [top, times] = await Promise.all([
    merchantRepo.merchantTopCategory(db, locale, mult, name, key),
    merchantRepo.merchantTimes(db, name, key),
  ]);
  let share: number | null = null;
  if (top?.id != null && top.amount > 0) {
    const cat = await merchantRepo.categoryTotalAllTime(db, mult, top.id, key);
    if (cat && cat.amount > 0) share = Math.round((top.amount / cat.amount) * 100);
  }
  return {
    total, n,
    avg: n > 0 ? Math.round(total / n) : 0,
    first_at: first, last_at: last,
    every_days: medianGapDays(times),
    top_category: top?.name ? { name: top.name, color: top.color, amount: top.amount } : null,
    category_share: share,
  };
}

export async function buildMerchant(env: Env, locale: NotifLocale, name: string): Promise<MerchantAnalytics> {
  const { mult } = valueMode(await getRates(env), null);
  const now = Math.floor(Date.now() / 1000);
  const from = localMonthStart(now, -(MONTHS - 1));
  const db = env.DB;

  const [agg, byMonth, txs] = await Promise.all([
    merchantRepo.merchantAggregate(db, mult, name),
    merchantRepo.merchantByMonth(db, mult, now, name, from),
    merchantRepo.merchantTransactions(db, locale, name, TX_LIMIT + 1),
  ]);
  const [spend, income] = await Promise.all([
    side(env, locale, mult, name, "spend", agg?.spent ?? 0, agg?.spend_n ?? 0, agg?.spend_first ?? null, agg?.spend_last ?? null),
    side(env, locale, mult, name, "income", agg?.income ?? 0, agg?.income_n ?? 0, agg?.income_first ?? null, agg?.income_last ?? null),
  ]);

  // A month with no payment is a fact the reader needs (a salary that skipped April), so the
  // series is the full calendar year, not only the months that had rows.
  const got = new Map(byMonth.map((r) => [r.m, r]));
  const by_month = Array.from({ length: MONTHS }, (_, i) => {
    const m = localYm(localMonthStart(now, i - (MONTHS - 1)));
    const r = got.get(m);
    return { month: m, spent: r?.spent ?? 0, income: r?.income ?? 0 };
  });

  const kind: MerchantAnalytics["kind"] =
    spend.n > 0 && income.n > 0 ? "mixed" : income.n > 0 ? "income" : spend.n > 0 || spend.total !== 0 ? "spend" : "none";

  return {
    name, kind, spend, income,
    refunds: { total: agg?.refunds ?? 0, n: agg?.refund_n ?? 0 },
    other_n: agg?.other_n ?? 0,
    total_n: agg?.total_n ?? 0,
    by_month,
    transactions: txs.slice(0, TX_LIMIT),
    has_more: txs.length > TX_LIMIT,
  };
}
