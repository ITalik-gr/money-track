/**
 * Budget-shaped notifications: what the envelopes already did, and where they are heading.
 *
 * Split out of `notify.ts` (2026-08-12) when lint C3 refused that file another line — the same
 * pressure that produced `deliver.ts`, and the same kind of seam. `notify.ts` owns the FEED (its
 * storage, its reading, its preferences and the one place a draft becomes a row); these two
 * functions own one financial subject and share a single source of truth for it (`budgetStatus`).
 *
 * They are deliberately together and not one file each: they are the SAME observation seen at two
 * moments — money already spent, and money projected — and keeping them apart is how the two would
 * eventually disagree about which envelope is in trouble.
 */
import type { Env } from "../../env.ts";
import type { Draft } from "./notify.ts";
import { getRates } from "../finance/finance.ts";
import { budgetStatus } from "../finance/budgets.ts";
import { valueMode, localYm, localParts } from "../finance/stats.ts";

/** Бюджети-конверти: вичерпані (≥100%) або на межі (≥90%). Розрахунок — `budgetStatus` (канон). */
export async function draftBudgets(env: Env, now: number): Promise<Draft[]> {
  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null);
  const monthKey = localYm(now);   // §APP_TZ — `budgetStatus` рахує місяць від локальної півночі

  const out: Draft[] = [];
  for (const b of await budgetStatus(env, mult, now)) {
    if (b.ratio < 0.9) continue;
    const over = b.ratio >= 1;
    out.push({
      kind: "budget",
      tkey: "budget",
      tparams: { name: b.name, over, spent: b.spent, amount: b.amount, pct: Math.round(b.ratio * 100) },
      severity: over ? "urgent" : "warn",
      entity_type: "category", entity_id: String(b.id),
      // Різні ключі для 90% і 100% — щоб «майже» не глушило подальше «вичерпано».
      dedup_key: `budget:${b.id}:${monthKey}:${over ? "over" : "warn"}`,
    });
  }
  return out;
}

/**
 * §BUDGET-FORECAST — an envelope heading over the limit, said while it still matters.
 *
 * `draftBudgets` above fires at 90% and 100% of money already spent, which is a rear-view mirror:
 * by the time it speaks, the only available response is to stop spending entirely. This one reads
 * the PROJECTION (`budgetStatus.projected`, the same `projectSpend` the pace radar uses) and says
 * it while there is still a month left to steer.
 *
 * The gates, each of which removes a way of being wrong:
 *  • **not before the 10th** — early in a month the projection is mostly history, and a warning
 *    on the 2nd is a statement about last month wearing this month's date;
 *  • **not once the money is already spent** (`ratio >= 0.9`) — `draftBudgets` owns that, and two
 *    events about one envelope on one day is the app arguing with itself;
 *  • **not for a lump** — a projection that was deliberately not extrapolated carries no forecast
 *    to warn about;
 *  • **≥110% projected AND ≥200 ₴ over** — a projection landing at 101% is inside the method's own
 *    error, and the same 200 ₴ floor the pace radar uses keeps small envelopes quiet.
 * ⚠️ ONE event per envelope per MONTH: the projection moves daily, and a key with the day in it
 * would turn a single slow overspend into a three-week drumbeat.
 */
export async function draftBudgetForecast(env: Env, now: number): Promise<Draft[]> {
  const { d: dayOfMonth } = localParts(now);
  if (dayOfMonth < 10) return [];

  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null);
  const monthKey = localYm(now);
  const MIN_OVER = 20000; // 200 ₴ — той самий поріг, що в «Радарі аномалій»

  const out: Draft[] = [];
  for (const b of await budgetStatus(env, mult, now)) {
    if (b.lumpy || b.ratio >= 0.9 || b.projected_ratio < 1.1) continue;
    if (b.projected - b.amount < MIN_OVER) continue;
    out.push({
      kind: "budget",
      tkey: "budget_forecast",
      tparams: {
        name: b.name, spent: b.spent, amount: b.amount,
        projected: b.projected, pct: Math.round(b.projected_ratio * 100),
      },
      severity: "warn",
      entity_type: "category", entity_id: String(b.id),
      dedup_key: `budget_fc:${b.id}:${monthKey}`,
    });
  }
  return out;
}
