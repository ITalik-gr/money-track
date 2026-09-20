/**
 * §RHYTHM on the INCOME side — who pays, how often, and who has stopped.
 *
 * Split out of `business.ts` on 2026-09-21 under C3, along the seam the page itself drew: the
 * business screen has a Clients tab now, and these are the two things on it that are about a
 * RHYTHM rather than about money (§BIZ-SPLIT). The import is ONE WAY — `business.ts` asks this
 * module and this module never asks back — so the split cannot turn into a cycle later.
 *
 * ⚠️ The median, never the mean, and a client's OWN gap, never a fixed threshold. Both rules are
 * bought by one failure: a rule tuned for a monthly client announces a twice-a-year one every
 * year, and misses the monthly one for a month.
 */
import type { AppDb } from "../platform/db-shim.ts";
import * as taxRepo from "../../repo/tax.ts";

const DAY = 86_400;

export interface Rhythm {
  /** Receipts in the window. */
  n: number;
  /** Median days between consecutive receipts; null under two receipts. */
  median_gap_days: number | null;
  /** Days since the last one — the number that says «it has gone quiet». */
  days_since_last: number | null;
  /** Average receipt, ₴ minor. */
  avg_uah: number;
}

/**
 * The MEDIAN gap, not the mean.
 *
 * One three-month gap in an otherwise monthly year drags a mean past six weeks and the reading
 * becomes «you get paid every month and a half», which is true of no month that actually happened.
 * The same reason §RHYTHM matches subscriptions on rhythm rather than on an average.
 */
export function rhythmOf(times: number[], now: number, totalUah: number): Rhythm {
  const n = times.length;
  if (n === 0) return { n: 0, median_gap_days: null, days_since_last: null, avg_uah: 0 };
  const gaps: number[] = [];
  for (let i = 1; i < n; i++) gaps.push((times[i]! - times[i - 1]!) / DAY);
  gaps.sort((a, b) => a - b);
  const median = gaps.length
    ? gaps.length % 2
      ? gaps[(gaps.length - 1) / 2]!
      : (gaps[gaps.length / 2 - 1]! + gaps[gaps.length / 2]!) / 2
    : null;
  return {
    n,
    median_gap_days: median == null ? null : Math.round(median),
    days_since_last: Math.floor((now - times[n - 1]!) / DAY),
    avg_uah: Math.round(totalUah / n),
  };
}

export interface QuietClient {
  name: string;
  /** How many payments the rhythm was read from. */
  n: number;
  median_gap_days: number;
  days_since_last: number;
  /** ₴ minor: what this client usually pays — the size of what has gone quiet. */
  avg_uah: number;
}

/**
 * A client who used to pay on a rhythm and has stopped — the income-side twin of §SUB-DETECT.
 *
 * The spending side has watched for a subscription that went quiet since the beginning; the income
 * side had nothing, and it is the more consequential of the two: a dead subscription is money
 * saved, a client who stopped paying is the business shrinking, and a freelancer normally notices
 * it weeks late because no single missing invoice looks like an event.
 *
 * ⚠️ RHYTHM, not a fixed threshold — the same rule §RHYTHM keeps. A client who pays monthly is
 * late at six weeks; a client who pays twice a year is not late at four months, and a «90 days
 * since last payment» rule would announce the second one every year while missing the first for a
 * month. So the comparison is against THIS client's own median gap.
 *
 * ⚠️ Three payments minimum, and a gap of at least a week. Two payments give one interval, which
 * is not a rhythm but a coincidence — and a client who pays every other day is «late» by lunchtime
 * on the third, which is how a signal becomes noise.
 */
export async function quietClients(db: AppDb, now: number, lookbackDays = 550): Promise<QuietClient[]> {
  const rows = await taxRepo.counterparties(db, now - lookbackDays * DAY, now, 100);
  const out: QuietClient[] = [];
  for (const c of rows) {
    if (c.n < 3 || c.name === "?") continue;
    const times = await taxRepo.receiptTimes(db, now - lookbackDays * DAY, now, c.name);
    const r = rhythmOf(times, now, c.total_uah);
    if (r.median_gap_days == null || r.median_gap_days < 7 || r.days_since_last == null) continue;
    // Twice the usual gap, and never sooner than a week past it: doubling alone would fire at 16
    // days for a client who pays weekly, which is inside the ordinary slack of an invoice.
    const late = r.days_since_last > Math.max(r.median_gap_days * 2, r.median_gap_days + 7);
    if (late) {
      out.push({
        name: c.name, n: r.n, median_gap_days: r.median_gap_days,
        days_since_last: r.days_since_last, avg_uah: r.avg_uah,
      });
    }
  }
  // The biggest payer first: «who has gone quiet» is a question about the business, and the
  // answer is ordered by how much of it is missing.
  return out.sort((a, b) => b.avg_uah - a.avg_uah);
}
