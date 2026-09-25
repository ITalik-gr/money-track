/**
 * What the report is told about the person's position BEYOND the period's own numbers — the
 * app's verdicts, so the report opens with what matters instead of restating the dashboard.
 *
 * Added 2026-09-25 (owner: «передивись репорти, щоб норм були, інформативні реально»). The report
 * saw only the period — totals, categories, merchants — and therefore could only ever narrate them:
 * a sentence version of the Statistics screen. Everything below is something the screens now know
 * and the report did not:
 *   · the health index and what moved (§HEALTH, via `healthForModel` — the same object chat gets);
 *   · how much of a typical month's income is already committed, and whether that is growing
 *     (§COMMITTED);
 *   · subscriptions whose latest cycle is NOT fine — late, missing, stopped, or charged at a new
 *     price (§PLAN-STATE) — the most actionable line a report can carry;
 *   · the subscription stack's drift over the year (§SUB-STACK).
 * All canon, all computed by the same functions the screens call; the model explains, never
 * recomputes (every figure is in the payload, so `numbersAreGrounded` holds it to them).
 */
import type { Env } from "../../env.ts";
import type { Rates } from "../finance/money.ts";
import { healthForModel } from "../finance/health.ts";
import { committedShare } from "../finance/committed.ts";
import { subscriptionStack } from "../finance/sub-stack.ts";
import { plannedActuals } from "../finance/subscriptions.ts";
import * as planningRepo from "../../repo/planning.ts";

const money = (minor: number) => Math.round(minor / 100);

export async function reportNews(env: Env, rates: Rates): Promise<Record<string, unknown>> {
  const [health, committed, stack, actuals, plans] = await Promise.all([
    healthForModel(env, rates),
    committedShare(env, rates),
    subscriptionStack(env, rates),
    plannedActuals(env.DB),
    planningRepo.activeWithCategory(env.DB),
  ]);
  const title = new Map(plans.map((p) => [p.id, p.title]));
  const attention = actuals
    .filter((a) => ["changed", "late", "missing", "stopped"].includes(a.state.kind))
    .map((a) => ({
      subscription: title.get(a.id) ?? `#${a.id}`,
      state: a.state.kind,
      late_days: a.state.late_days,
      charged_uah: a.state.paid_amount != null ? money(a.state.paid_amount) : null,
      price_change_pct: a.price_change_pct,
    }));
  return {
    ...health,
    committed_income: committed.share == null ? null : {
      share_pct: Math.round(committed.share * 100),
      recurring_floor_uah: money(committed.floor),
      typical_income_uah: committed.income != null ? money(committed.income) : null,
      free_uah: committed.free != null ? money(committed.free) : null,
      trend: committed.trend.map((p) => ({ month: p.ym, share_pct: p.share != null ? Math.round(p.share * 100) : null })),
    },
    subscriptions_attention: attention,
    subscription_stack: stack.drift ? { monthly_then_uah: money(stack.drift.from_avg), monthly_now_uah: money(stack.drift.to_avg), change_pct: stack.drift.pct } : null,
    news_note: "health_index opens the report: name its band and the part with the biggest gap (see health_note). committed_income is the share of a typical month's income the RECURRING floor already takes (one-offs and the tax reserve excluded); name it and say whether its trend is rising. subscriptions_attention lists subscriptions whose latest cycle is not fine: 'late' (charge overdue — ask, do not accuse: «not linked» is not «not paid»), 'missing' (two cycles with nothing), 'stopped' (three or more — probably cancelled; suggest ending the plan), 'changed' (charged at a new price — say old→new). If it is non-empty it belongs in the report's first section. subscription_stack is how the whole subscription stack's actual monthly charges moved over the year. End the report with what is COMING (the next period), not with a recap.",
  };
}
