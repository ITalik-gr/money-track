/**
 * §ENV-STATE — the one verdict on an envelope, shared by the envelope grid and «Потребує уваги».
 *
 * Both used to decide «over» on their own, with different boundaries (`ratio > 1` in the grid,
 * `ratio >= 1` in the card), so rent that exactly equals its envelope read «ліміт перевищено» on
 * the dashboard while the grid showed it as fine. Exactly spent is its own state — «вичерпано» —
 * and the boundary is the percentage the screen PRINTS: an envelope shown as «100%» is never
 * called over, and one shown as «101%» always is.
 *
 * Presentation only: `ratio` is the canon's (`budgetStatus`), nothing is recomputed. A zero
 * envelope (§BUDGET-ZERO) is binary — the canon reports a broken one as exactly 1.
 */
export type EnvelopeState = "over" | "full" | "warn" | "ok";

export function envelopeState(r: { amount: number; spent: number; ratio: number }): EnvelopeState {
  if (r.amount === 0) return r.spent > 0 ? "over" : "ok";
  const pct = Math.round(r.ratio * 100);
  return pct > 100 ? "over" : pct === 100 ? "full" : pct >= 80 ? "warn" : "ok";
}

/**
 * §BUDGET-TRANSFER — «Перекази і зняття» (and its children) never holds an envelope.
 *
 * Moving one's own money is excluded from spending (`SPEND_WHERE`), so an envelope there reads 0%
 * forever — a limit that can never be measured, shown as if it were being kept. The owner had one.
 * Refused on write, absent from every picker, and migration 0058 removed the ones that existed.
 */
export const TRANSFER_CAT_ID = 13;
