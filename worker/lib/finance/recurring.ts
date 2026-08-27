/**
 * §SUB-DETECT (2026-08-27) — "what am I paying for regularly that I never declared".
 *
 * WHAT WAS WRONG. Detection lived as one SQL `GROUP BY t.merchant, t.amount HAVING n >= 2 AND
 * months >= 2`, i.e. it recognised a subscription by the EXACT hryvnia amount repeating under the
 * EXACT merchant string. Three consequences, all silent:
 *
 *   • **A foreign-currency subscription was never detected.** Claude, Spotify, X, Cloudflare — the
 *     owner's actual subscriptions — are billed abroad and settle in the card's currency at the
 *     day's rate, so the amount differs every month. Each charge formed its own group with `n = 1`
 *     and fell out at `HAVING`. The feature was missing precisely the payments it exists for.
 *   • «X Corp.» / «X Corp» / «X CORP.» were three merchants.
 *   • **Nothing measured RHYTHM.** Exact-amount equality was standing in for it, badly: it let
 *     through a coffee bought for the same 65 ₴ eleven times, and the cadence filter afterwards
 *     could only look at an average interval that a burst of purchases makes meaningless.
 *
 * WHAT IT DOES NOW. Rows come out of `repo/planning.ts` raw; the grouping is judgement and lives
 * here (the same seam as `levels.ts` — SQL canon in one place, the reading of it in another):
 *
 *   • the merchant key is `coreToken` (`merchants.ts`), this project's ONE answer to "is this the
 *     same merchant, roughly" — already what §SIMILAR, the consensus categoriser and the
 *     transliteration merge use, so a fourth definition here would be §CUR-PLAN again;
 *   • amounts group into a BUCKET of ±10%, the same tolerance `amountMatches` uses to attach a
 *     charge to a declared plan. One number for both directions, or the app would propose a
 *     subscription it then refuses to link;
 *   • rhythm is measured: the gaps between consecutive charges must be CONSISTENT (relative
 *     spread ≤ `GAP_SPREAD_MAX`), which is what actually separates a subscription from a shop.
 */
import { coreToken } from "./merchants.ts";
import { localYm, localParts } from "./time.ts";
import type { RecurringCandidate } from "../../../shared/api/planning.ts";

/** One charge, as the repo hands it over. */
export interface ChargeRow {
  merchant: string;
  amount: number;          // minor units, POSITIVE (the repo negates)
  time: number;
  currency_code: number;
  category_id: number | null;
}

/**
 * ±10% — the SAME tolerance as `amountMatches` in `subscriptions.ts`.
 *
 * It has to be: this decides what gets PROPOSED, and that one decides what gets LINKED. A
 * subscription the app suggests and then cannot attach a single charge to is worse than one it
 * never suggested — it lands the user in exactly the «списань не видно» state §PLAN-LINK removed.
 */
const AMOUNT_TOLERANCE = 0.1;

/**
 * How ragged the intervals may be and still read as a schedule.
 *
 * A monthly biller lands on 28–31 day gaps (spread ≈ 0.05); a card that charges on the 1st and
 * whose February is short still sits far under this. A shop visited whenever produces gaps of
 * 2 and 40 days in the same series. 0.45 is loose enough to survive a failed payment retried three
 * days later, which is a real thing and not a different subscription.
 */
const GAP_SPREAD_MAX = 0.45;

/** Below this many charges there is no rhythm to measure — two points make one gap. */
const MIN_CHARGES = 2;

/**
 * What share of a merchant's charges the bucket must hold — the rule that separates a biller
 * from a shop, and the one the first draft of this file was missing.
 *
 * A merchant charged at ONE price is a subscription; a merchant charged at whatever the basket
 * costs is a shop. Without this, the ±10% bucketing chopped «Сільпо» into three proposals of 424,
 * 392 and 479 ₴, each of which passed the rhythm test by coincidence — three false subscriptions
 * for one grocery habit, which is worse than the exact-amount rule it replaced, because a
 * proposal the user has to dismiss costs more trust than one never made.
 *
 * ⚠️ Named cost: a subscription whose PRICE ROSE mid-window splits roughly in half and can fall
 * under the threshold, so it is proposed later — once the new price has been charged more often
 * than the old. A miss is recoverable (the charge is still in the ledger, and §HABITS names newly
 * regular merchants separately); a false proposal teaches the user to ignore the whole block.
 */
const BUCKET_DOMINANCE = 0.6;

/** Cadence the proposal covers: weekly through quarterly. Daily is a habit, yearly is not
 *  distinguishable from two unrelated purchases inside the window we can afford to read. */
const MIN_INTERVAL_DAYS = 6;
const MAX_INTERVAL_DAYS = 100;

/**
 * §RHYTHM (2026-08-27) — how a series of charges is actually PACED. ONE definition.
 *
 * The subscription page had its own: `(last − first) / (n − 1)`, a mean that ONE gap destroys.
 * Real case — Apple, charged on the 6th of every month without fail. Five charges in the ledger,
 * four linked to the plan (the July one was not), so the page read Apr 6 → Aug 6 over three gaps
 * and announced «кожні ~41 дн» about a subscription that bills monthly, plus a warning that the
 * billing rhythm had drifted. Both were artefacts of one missing row.
 *
 * The median gap answers the same question and survives a hole: gaps of 30, 31 and 61 give 31.
 * ⚠️ `day_of_month` is the better answer WHEN IT EXISTS, and it is the one the owner used to spot
 * the bug: «воно завжди списує 6 числа». An interval is a derived quantity; a billing day is what
 * the biller actually does, and it is what a person can check against their own memory.
 * ⚠️ The day is read in KYIV time (§APP_TZ) — a charge at 01:00 on the 6th is the 5th in UTC, and
 * a "stable day" test in the wrong zone would call a perfectly regular plan irregular.
 */
export interface Rhythm {
  /** Days between consecutive charges, median — robust to a skipped month. `null` under 2 charges. */
  interval_days: number | null;
  /** The day of the month it bills on, when every charge agrees within ±`DAY_TOLERANCE`. */
  day_of_month: number | null;
  /** Gaps that are ≥1.5× the median — a month the biller skipped, or a charge nothing linked. */
  skipped: number;
}

/** A biller that moves the date by a day or two (weekend, retry) is still billing on that day. */
const DAY_TOLERANCE = 2;
/** Above this multiple of the median, a gap is a hole rather than jitter. */
const SKIP_FACTOR = 1.5;

export function chargeRhythm(times: number[]): Rhythm {
  const t = [...times].sort((a, b) => a - b);
  if (t.length < 2) return { interval_days: null, day_of_month: null, skipped: 0 };

  const gaps: number[] = [];
  for (let i = 1; i < t.length; i++) gaps.push(Math.round((t[i] - t[i - 1]) / 86400));
  const interval = median(gaps);
  const skipped = gaps.filter((g) => g >= interval * SKIP_FACTOR).length;

  // The billing day, only when the charges agree on one. Compared circularly, so the 1st and the
  // 30th are not "29 days apart" — a plan billing on the 1st drifts to the 30th of the month before
  // whenever the bank posts a day early, and reading that as instability is the same class of
  // error as the mean interval above.
  const days = t.map((x) => localParts(x).d);
  const anchor = days[days.length - 1];
  const stable = days.every((d) => {
    const diff = Math.abs(d - anchor);
    return Math.min(diff, 31 - diff) <= DAY_TOLERANCE;
  });

  return { interval_days: interval, day_of_month: stable ? anchor : null, skipped };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

interface Group {
  merchant: string;        // the longest spelling seen — the one a person recognises
  currency_code: number;
  charges: ChargeRow[];
  /** How many charges this merchant made in the window, across ALL its price buckets. */
  merchantTotal: number;
}

/**
 * Bucket charges into "same merchant, about the same amount, same currency".
 *
 * The amount bucket is grown GREEDILY around the first charge of a merchant rather than rounded to
 * a grid: a grid puts 199 and 201 in different buckets for no reason a person would accept, and
 * the question here is only ever "is this the same recurring price".
 */
function group(rows: ChargeRow[]): Group[] {
  const byMerchant = new Map<string, ChargeRow[]>();
  for (const r of rows) {
    const key = coreToken(r.merchant);
    if (!key) continue;
    (byMerchant.get(key) ?? byMerchant.set(key, []).get(key)!).push(r);
  }

  const out: Group[] = [];
  for (const charges of byMerchant.values()) {
    // Within one merchant, split by currency first — a plan carries ONE currency (§CUR-PLAN), so a
    // merchant billing in two of them is two proposals, not one averaged nonsense.
    const byCur = new Map<number, ChargeRow[]>();
    for (const r of charges) (byCur.get(r.currency_code) ?? byCur.set(r.currency_code, []).get(r.currency_code)!).push(r);

    for (const [currency_code, list] of byCur) {
      const buckets: ChargeRow[][] = [];
      for (const r of [...list].sort((a, b) => a.amount - b.amount)) {
        const b = buckets.find((x) => Math.abs(r.amount - x[0].amount) <= x[0].amount * AMOUNT_TOLERANCE);
        if (b) b.push(r); else buckets.push([r]);
      }
      for (const b of buckets) {
        // The name shown is the LONGEST spelling in the bucket: «X Corp.» reads as something,
        // «X» does not, and the core token itself («corp») is not a merchant name at all.
        const merchant = b.map((r) => r.merchant).sort((a, x) => x.length - a.length)[0];
        out.push({ merchant, currency_code, charges: b, merchantTotal: list.length });
      }
    }
  }
  return out;
}

/** Turn grouped charges into proposals, keeping only what actually looks scheduled. */
export function recurringCandidates(rows: ChargeRow[], now = Math.floor(Date.now() / 1000)): RecurringCandidate[] {
  const out: RecurringCandidate[] = [];

  for (const g of group(rows)) {
    if (g.charges.length < MIN_CHARGES) continue;
    // One price, or many? See BUCKET_DOMINANCE — this is what keeps a grocery shop out.
    if (g.charges.length / g.merchantTotal < BUCKET_DOMINANCE) continue;
    const times = g.charges.map((c) => c.time).sort((a, b) => a - b);

    // ⚠️ §APP_TZ: months are Kyiv months. In UTC a charge made just after midnight falls into the
    // previous month and could supply the second month all by itself — the gate that turns a
    // repeated charge into a proposal.
    const months = new Set(times.map((t) => localYm(t))).size;
    if (months < 2) continue;

    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(Math.round((times[i] - times[i - 1]) / 86400));
    const typical = median(gaps);
    if (typical < MIN_INTERVAL_DAYS || typical > MAX_INTERVAL_DAYS) continue;

    // Rhythm. Measured against the MEDIAN gap, not the mean: one late payment should not be able
    // to move the yardstick it is then judged against.
    const spread = typical > 0
      ? gaps.reduce((s, d) => s + Math.abs(d - typical), 0) / gaps.length / typical
      : 1;
    if (spread > GAP_SPREAD_MAX) continue;

    // The amount PROPOSED is the median charge, not the mean and not the latest: a plan's declared
    // price should survive one FX spike, and the latest charge is the one most likely to be it.
    const amount = median(g.charges.map((c) => c.amount));
    // The category is the commonest among the charges themselves — the app's own past decisions
    // about this merchant, which is a better guess than anything derivable here.
    const catCount = new Map<number, number>();
    for (const c of g.charges) if (c.category_id != null) catCount.set(c.category_id, (catCount.get(c.category_id) ?? 0) + 1);
    const category_id = [...catCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    out.push({
      merchant: g.merchant,
      amount,
      n: g.charges.length,
      first_time: times[0],
      last_time: times[times.length - 1],
      months,
      avg_interval_days: typical,
      currency_code: g.currency_code,
      category_id,
    });
  }

  // Most recent and most frequent first — a proposal about a charge from five months ago is
  // history, one about last week is a decision.
  const recent = (c: RecurringCandidate) => (now - c.last_time) / 86400;
  return out
    .sort((a, b) => (recent(a) < 45 ? 0 : 1) - (recent(b) < 45 ? 0 : 1) || b.n - a.n || b.last_time - a.last_time)
    .slice(0, 20);
}
