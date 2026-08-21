/**
 * §CADENCE — when is a period-over-period delta a CHANGE, and when is it a calendar artefact.
 *
 * A category billed once a month, looked at through a one-week window, lands inside one window
 * and outside its neighbour. The arithmetic is then perfectly correct and completely misleading:
 * «підписки −92%» is not a drop in subscriptions, it is the 1st of the month falling on the other
 * side of the line. This was found in a weekly AI report on 2026-08-01 and fixed there — inside
 * `report.ts`, as three inline expressions.
 *
 * That was one reader out of three. `/analytics/compare` feeds two screens (Statistics →
 * Порівняння, and the period block on Категорії) and both of them merged the two sides IN THE
 * CLIENT and printed the percentage with nothing standing between the subtraction and the eye.
 * So the app had already decided that this delta is noise, said so to the model, and kept showing
 * it to the person — which is the worse half, because the model is told to be careful and the
 * reader is not.
 *
 * Hence one function. The rule is not obvious enough to be re-derived correctly at a second call
 * site, and a second spelling of it would drift exactly where nobody compares them (§CUR-PLAN,
 * §REFUND, §A1-WRITE — the same shape three times).
 */

/**
 * Below this, a window cannot contain two of a monthly charge.
 *
 * 28 and not 30: February exists, and a window has to be able to hold a full monthly cycle
 * regardless of which month it lands in. Above it, a monthly biller appears on both sides by
 * construction, so the delta is about amounts again and needs no defence.
 */
export const SHORT_PERIOD_DAYS = 28;

export function isShortPeriod(days: number): boolean {
  return days < SHORT_PERIOD_DAYS;
}

/** Days in a `[from, to]` window of unix seconds, as the period rules count them. */
export function periodDays(from: number, to: number): number {
  return Math.max(1, Math.round((to - from) / 86400));
}

/**
 * Is the difference between `n` charges now and `prevN` charges then worth reading as behaviour?
 *
 * ⚠️ **Two on BOTH sides**, not two in total. One charge against two is the timing case in its
 * purest form: something that bills monthly was caught twice by a 30-day window that happened to
 * straddle two billing dates. Requiring both sides is what makes the test symmetric — a category
 * that genuinely stopped (2 → 0) is not meaningful either, and that is correct: what the reader
 * needs there is «зникло», which the UI says in words, not a percentage of nothing.
 *
 * ⚠️ Counts must come from `SPEND_TX_COUNT`, never `SPEND_COUNT`: the latter counts ROWS after
 * `STATS_JOINS`, so one split expense weighs three and a subscription looks daily.
 */
export function deltaMeaningful(days: number, n: number, prevN: number): boolean {
  return !isShortPeriod(days) || (n >= 2 && prevN >= 2);
}

// ---- period comparison ------------------------------------------------------

/** One side of the comparison, as `repo/analytics.compareByCategory` returns it. */
export interface CompareSide {
  category_id: number | null;
  category_name: string | null;
  color: string | null;
  spent: number;
  n: number;
}

/**
 * The noise floor for «найбільші зміни», in HRYVNIA minor units.
 *
 * ⚠️ It is stated in hryvnia and converted by the caller, exactly like every other stored plan
 * amount (§BASE-CUR). The two client copies this replaces were a bare `5000`, which meant 50 ₴ for
 * the owner and $50 for anyone reading in dollars — a fortyfold difference in what counts as
 * noise, on a screen whose whole job is to say what changed.
 */
export const MOVERS_FLOOR_UAH_MINOR = 5000;

/** `spent` is deliberately NOT carried through: it would be a second name for `a`. */
export interface ComparedRow extends Omit<CompareSide, "spent"> {
  a: number;
  b: number;
  prev_n: number;
  delta: number;
  delta_meaningful: boolean;
}

/**
 * Merge the two windows into one row per category, and pick the movers.
 *
 * Pure on purpose — no database, no rates, no locale — because every input is already resolved
 * and the two screens that read this must not be able to disagree about the answer.
 *
 * ⚠️ Rows are sorted by the BIGGER of the two sides, not by the current one. A category that
 * vanished is frequently the answer to «що змінилось», and sorting by `a` alone pushes it to the
 * bottom of the list precisely when it matters most.
 */
export function buildCompare(
  aRows: CompareSide[], bRows: CompareSide[], opts: { days: number; floor: number },
): { rows: ComparedRow[]; movers: { up: ComparedRow[]; down: ComparedRow[] } } {
  const map = new Map<number | null, ComparedRow>();
  const put = (r: CompareSide, side: "a" | "b") => {
    const prev = map.get(r.category_id);
    if (prev) {
      if (side === "a") { prev.a = r.spent; prev.n = r.n; } else { prev.b = r.spent; prev.prev_n = r.n; }
      // A category present in both windows keeps whichever name and colour it has; they are the
      // same row in `categories`, so the two sides can only differ if one of them is missing.
      prev.category_name ??= r.category_name;
      prev.color ??= r.color;
      return;
    }
    map.set(r.category_id, {
      category_id: r.category_id, category_name: r.category_name, color: r.color,
      a: side === "a" ? r.spent : 0,
      b: side === "b" ? r.spent : 0,
      n: side === "a" ? r.n : 0,
      prev_n: side === "b" ? r.n : 0,
      delta: 0, delta_meaningful: true,
    });
  };
  for (const r of aRows) put(r, "a");
  for (const r of bRows) put(r, "b");

  const rows = [...map.values()];
  for (const r of rows) {
    r.delta = r.a - r.b;
    r.delta_meaningful = deltaMeaningful(opts.days, r.n, r.prev_n);
  }
  rows.sort((x, y) => Math.max(y.a, y.b) - Math.max(x.a, x.b));

  // A mover has to clear BOTH tests. The floor keeps a 12 ₴ wobble out of a list of three, and
  // §CADENCE keeps out the rent that simply landed on the other side of the line — the second
  // one is what this list was getting wrong, and it was getting it wrong loudest, because a
  // whole month of a monthly bill is by definition a large number.
  const moving = rows.filter((r) => Math.abs(r.delta) >= opts.floor && r.delta_meaningful);
  return {
    rows,
    movers: {
      up: moving.filter((r) => r.delta > 0).sort((x, y) => y.delta - x.delta).slice(0, 3),
      down: moving.filter((r) => r.delta < 0).sort((x, y) => x.delta - y.delta).slice(0, 3),
    },
  };
}
