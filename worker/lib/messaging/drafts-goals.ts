/**
 * §GOAL-PACE in the feed — "this goal is not going to make it".
 *
 * Split out of `notify.ts` on 2026-09-02 under lint C3, alongside the budget, import and AI
 * drafters that were separated for the same reason. The seam is the same one they used: `notify.ts`
 * decides WHAT is worth saying and how it is delivered; a drafter knows one subject.
 *
 * The verdict itself is NOT computed here — `goalPace` is, and it is the same call the goal card
 * makes. This drafter once had its own arithmetic, and the feed could therefore name a monthly
 * rate written nowhere on the goal it was talking about.
 */
import type { Env } from "../../env.ts";
import { getRates, toBaseMinor } from "../finance/money.ts";
import { goalPace, goalNeedsAttention, goalCurrency } from "../finance/goals.ts";
import { localYmd } from "../finance/stats.ts";
import type { Draft } from "./notify.ts";

/** Київський день (§APP_TZ) — той самий вираз, яким дедупиться решта стрічки. */
const isoDay = (unix: number) => localYmd(unix);

/** Ціль не встигає: прогрес відстає від часу, що минув, або дедлайн уже близько. */
export async function draftGoalRisk(env: Env, now: number): Promise<Draft[]> {
  const rows = await env.DB.prepare(
    `SELECT g.id, g.name, g.target_amount, g.current_amount, g.deadline, g.created_at, g.currency_code,
            a.balance AS account_balance, a.currency_code AS account_currency
     FROM savings_goals g LEFT JOIN accounts a ON a.id = g.account_id
     WHERE g.is_active = 1 AND g.deadline IS NOT NULL AND g.target_amount > 0`,
  ).all<{
    id: number; name: string; target_amount: number; current_amount: number;
    deadline: number; created_at: number | null; account_balance: number | null;
    currency_code: number | null; account_currency: number | null;
  }>();

  const out: Draft[] = [];
  const today = isoDay(now);
  /**
   * §GOAL-CUR + §BASE-CUR, and they pull in opposite directions here.
   *
   * A goal's figures are in the GOAL's currency (its jar's, when a jar backs it), while
   * `insertDrafts` stamps every event with the base its numbers are in — so the conversion is
   * from the goal's unit into the base, once, at the edge. It used to read `uahToBaseMinor` over
   * a JAR BALANCE, i.e. it treated a dollar jar as hryvnia and then converted that: the feed
   * could announce a goal was behind using a figure ~40× off the card next to it.
   */
  const rates = await getRates(env);
  for (const g of rows.results ?? []) {
    const cur = goalCurrency(g);
    const current = toBaseMinor(g.account_balance ?? g.current_amount, cur, rates);   // банка-джерело має пріоритет
    const target = toBaseMinor(g.target_amount, cur, rates);
    // §GOAL-PACE: the same computation the goal card itself displays. Until now this drafter had
    // its own arithmetic, so the feed could name a monthly rate written nowhere on the goal.
    const p = goalPace({ ...g, target_amount: target, current }, now);
    if (!goalNeedsAttention(p)) continue;
    // A sprint (<1 month) has no monthly rate — the only meaningful figure there is the whole
    // remaining amount. That is exactly what the drafter used to show via `max(1, days / 30)`.
    const perMonth = p.per_month ?? p.left;
    out.push({
      kind: "goal_risk",
      tkey: "goal_risk",
      tparams: {
        name: g.name, passed: p.status === "overdue",
        current, target, progressPct: Math.round(p.progress_frac * 100),
        elapsedPct: Math.round((p.elapsed_frac ?? 0) * 100), perMonth, daysLeft: p.days_left ?? 0,
      },
      severity: p.status === "overdue" || p.status === "at_risk" ? "warn" : "info",
      entity_type: "goal", entity_id: String(g.id),
      // Раз на тиждень: щоденне нагадування про ту саму ціль — це вже докучання.
      dedup_key: `goal_risk:${g.id}:${today.slice(0, 8)}${Math.floor(Number(today.slice(8)) / 7)}`,
    });
  }
  return out.slice(0, 3);
}

