/**
 * §SHAPE (2026-08-27) — three questions the Statistics page could not answer, all about the SHAPE
 * of a period rather than its size.
 *
 * Every existing block answers "how much, and where": totals, categories, merchants, weekdays,
 * pace. Two months with the same total and the same categories can still be completely different
 * months, and the difference is what a person can actually act on:
 *
 *   1. **Cheque size.** A few large payments or a hundred small ones? Opposite remedies, identical
 *      totals. The page had an average and a maximum, which are the two figures that hide it.
 *   2. **Outside the envelopes.** `/plan` shows the envelopes that exist and how full they are —
 *      nothing said what share of the money never passes through one. Every envelope can be green
 *      while most of the spending happens somewhere else entirely.
 *   3. **Unattributed.** Every other answer on the page is about categories, so the honest first
 *      question is how much of the window those answers do not cover. The feed nags about ten
 *      uncategorised OPERATIONS; ten small ones and ten large ones are very different amounts of
 *      doubt.
 *
 * All three read the canonical spend population (`STATS_JOINS` + `SPEND_WHERE`), so they add up
 * against the same `spend` total every other block on the page is drawn from.
 */
import type { Env } from "../../env.ts";
import type { SpendingShape } from "../../../shared/api/analytics.ts";
import * as analyticsRepo from "../../repo/analytics.ts";
import { uahToBaseMinor, type Rates } from "./money.ts";

/**
 * Cheque-size boundaries, in HRYVNIA minor units, converted to the reader's base on use.
 *
 * §BASE-CUR: a bare `10000` here would mean 100 ₴ for the owner and $100 for an English reader —
 * the same mistake `MOVERS_FLOOR_UAH_MINOR` was written to avoid (§CADENCE). The steps are
 * deliberately round rather than derived from the data: a boundary that moves with the month makes
 * two months incomparable, which is the one thing this block exists to enable.
 */
const CHEQUE_STEPS_UAH_MINOR = [10_000, 50_000, 200_000];

export async function spendingShape(
  env: Env, v: analyticsRepo.ValueScope, r: analyticsRepo.Range, rates: Rates,
): Promise<SpendingShape> {
  const steps = CHEQUE_STEPS_UAH_MINOR.map((x) => uahToBaseMinor(x, rates));
  const [rows, unbudgeted, uncategorised, totals] = await Promise.all([
    analyticsRepo.chequeSizes(env.DB, v, r, steps),
    analyticsRepo.unbudgetedSpend(env.DB, v, r),
    analyticsRepo.uncategorisedSpend(env.DB, v, r),
    analyticsRepo.periodTotals(env.DB, v, r),
  ]);

  const spend = totals.spend ?? 0;
  const share = (part: number) => (spend > 0 ? Math.round((part / spend) * 1000) / 10 : null);

  // Every bucket is returned, including the empty ones: a missing bar reads as "no data here",
  // while a zero-height one says "nothing this size", and those are different facts about a month.
  const byBucket = new Map(rows.map((x) => [x.bucket, x]));
  const buckets = [...steps, null].map((upTo, i) => {
    const hit = byBucket.get(i);
    return {
      up_to: upTo,
      from: i === 0 ? 0 : steps[i - 1],
      n: hit?.n ?? 0,
      spent: hit?.spent ?? 0,
      share_pct: share(hit?.spent ?? 0) ?? 0,
    };
  });

  return {
    spend,
    buckets,
    unbudgeted: { spent: unbudgeted.spent, n: unbudgeted.n, share_pct: share(unbudgeted.spent) },
    uncategorised: { spent: uncategorised.spent, n: uncategorised.n, share_pct: share(uncategorised.spent) },
  };
}
