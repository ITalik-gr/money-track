/**
 * `/insights/*` — derived readings of a period. Companion to `analytics.ts`, which declares what
 * the numbers ARE; these shapes answer questions ABOUT them.
 *
 * Money is minor units of the reader's display base (§BASE-CUR) unless a field says otherwise.
 * Shares are fractions of 1, never percentages: a percentage in a payload is a rounding decision
 * made too early, and the screen is where rounding belongs.
 */

// ---- §SPEND-PROFILE ---------------------------------------------------------

/** Days of the window nothing was spent, and the longest unbroken run of them. */
export interface QuietDays {
  quiet: number;
  /** Whole days in the window, in APP_TZ — today is excluded until it is over. */
  days: number;
  longest_streak: number;
}

/** How few merchants make up the period. Ranking is `/analytics`; this is shape. */
export interface Concentration {
  merchants_for_half: number;
  merchants: number;
  /** 0..1 */
  top5_share: number;
}

/** Money that went to merchants with no charge anywhere BEFORE this window. */
export interface NewFaces {
  spent: number;
  merchants: number;
  /** 0..1 */
  share: number;
}

export interface SpendProfile {
  from: number;
  to: number;
  /** The period's spending, so every share above can be checked against one number. */
  total: number;
  quiet_days: QuietDays;
  concentration: Concentration;
  new_faces: NewFaces;
}

// ---- §MOMENTUM --------------------------------------------------------------

export interface MomentumRow {
  category_id: number;
  name: string;
  color: string | null;
  direction: "up" | "down";
  /** Consecutive monthly moves in that direction, counting back from the last complete month. */
  run: number;
  /** One figure per month in `Momentum.months`, oldest first. */
  series: number[];
  change: number;
  /** 0..1+, or `null` when the run started from nothing and a ratio would be meaningless. */
  change_pct: number | null;
}

export interface Momentum {
  /** `YYYY-MM`, oldest first, COMPLETE months only — the current one is never here. */
  months: string[];
  rows: MomentumRow[];
}

// ---- §INCOME-SPLIT ----------------------------------------------------------

export interface IncomeAllocation {
  from: number;
  to: number;
  income: number;
  essential: number;
  discretionary: number;
  optional: number;
  /** `income − spending`. NEGATIVE when the period ran on savings, and shown that way. */
  left: number;
  /** Shares OF INCOME — so they exceed 1 exactly when `left` is negative. `null` with no income. */
  shares: { essential: number; discretionary: number; optional: number; left: number } | null;
}

// ---- §FLOOR -----------------------------------------------------------------

export interface FloorPart { category_id: number; name: string; color: string | null; level: number }

export interface SpendFloor {
  /** The repeating part of the burn: what a month costs with no decisions in it. */
  floor: number;
  /** The canonical monthly burn. `floor + lumpy === burn` — parts of it, never additions to it. */
  burn: number;
  lumpy: number;
  cushion: number;
  /** Against the FULL burn — the same runway every other screen shows, and the headline. */
  runway_months: number | null;
  /** Against the floor alone. Always the larger; a second answer, never a replacement. */
  floor_months: number | null;
  parts: FloorPart[];
}
