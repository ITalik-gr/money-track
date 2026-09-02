/**
 * §3 — the AI budget planner: propose envelope limits, and argue about them in chat.
 *
 * Split out of `advisor.ts` on 2026-08-27 under lint C3. The seam is real: `advisor.ts` answers
 * "how is the user doing" from ONE snapshot; this file builds a DIFFERENT payload (every category
 * with its canonical level and its current limit) for a different question — what the limits
 * should be. It borrows three primitives from the advisor and exports nothing back, so the import
 * runs one way; the three call sites import from here directly rather than through a re-export,
 * which would have closed a cycle (the same reason `facts.ts` was split out on 2026-08-07).
 *
 * ⚠️ The level is the CANON (`categoryMonthlyLevels`), never a private average: a proposal built
 * on a second definition of "per month" would argue with the envelope grid that then measures it.
 */
import type { Env } from "../../env.ts";
import type { ChatMsg } from "./ai.ts";
import { type BudgetChatResult, budgetChat } from "./tasks.ts";
import { proposeBudgetLimits } from "./generate.ts";
import { briefUsage, logUsage, type AiUsageBrief } from "./cost.ts";
import { getRates } from "../finance/money.ts";
import {
  STATS_JOINS, EFF_CAT_ID, EFF_CAT_NAME, EFF_CAT_COLOR, EFF_IMPORTANCE, SPEND_WHERE,
  valueMode, amountSum, categoryMonthlyLevels, sumLevels, burnShape,
} from "../finance/stats.ts";
import { coveredMonths, levelWindowKeys } from "../finance/levels.ts";
import { catNameSql } from "../finance/categories-i18n.ts";
import { resolveLocale } from "../platform/i18n.ts";
import { ownFundsUAH, getProfile } from "./advisor.ts";
import type { BudgetProposalRow, BudgetPlanResult } from "../../../shared/api/planning.ts";

// AI-планувальник бюджету: середні витрати по категоріях + ситуація → пропозиції
// місячних лімітів-конвертів (приймаються одним тапом на сторінці «Бюджети»).
//
// ⚠️ The shapes come from `shared/api/` (C2/C4). They were declared a SECOND time here, byte for
// byte apart from three trailing comments — the exact defect those lints exist for, and invisible
// while both copies happened to agree.

export async function proposeBudgets(env: Env): Promise<BudgetPlanResult> {
  const loc = await resolveLocale(env);
  const now = Math.floor(Date.now() / 1000);
  const from90 = now - 90 * 86400;

  const rates = await getRates(env);
  const { mult } = valueMode(rates, null);
  const [ownFunds, spendRows, budgetRows] = await Promise.all([
    ownFundsUAH(env, rates),
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS category_id, ${catNameSql(loc, EFF_CAT_NAME)} AS name, ${EFF_CAT_COLOR} AS color, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND ${SPEND_WHERE} AND ${EFF_CAT_ID} IS NOT NULL
       GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC`,
    ).bind(from90).all<{ category_id: number; name: string; color: string | null; spent: number }>(),
    env.DB.prepare("SELECT category_id, amount FROM budgets WHERE period = 'month'").all<{ category_id: number; amount: number }>(),
  ]);

  const cats = spendRows.results ?? [];
  const currentLimit = new Map<number, number>();
  for (const b of budgetRows.results ?? []) if (b.category_id != null) currentLimit.set(b.category_id, b.amount);

  // Канонічний місячний рівень (fixed=останній платіж, змінні=середнє) — узгоджено з рештою.
  const levels = await categoryMonthlyLevels(env, mult, { now });
  const catLevel = (id: number, spent90: number) => levels.get(id)?.level ?? Math.round(spent90 / 3);

  // P1: burn = сума канонічних місячних рівнів (узгоджено з порадником/патернами).
  const monthlyBurn = sumLevels(levels);
  const runwayMonths = monthlyBurn > 0 ? Math.round((ownFunds / monthlyBurn) * 10) / 10 : null;

  /**
   * The SHAPE of each category, not only its size.
   *
   * The payload used to be one number per category — the canonical level — and a quarterly tax
   * looked exactly like rent in it. So the plan opened envelopes for «Податки» and «Освіта» at a
   * monthly figure in a month neither will be charged in, and the owner read that, correctly, as
   * the planner not understanding his year. The app already computes the distinction for itself
   * (§BURN-SHAPE decides which half of burn repeats), so the fix is to HAND OVER what it knows
   * rather than to ask the model to infer it from an average that hides it by construction.
   */
  const covered = (await coveredMonths(env, levelWindowKeys(now))).length;
  const payload = {
    situation: (await getProfile(env)) || "(not specified)",
    own_funds_uah: Math.round(ownFunds / 100),
    monthly_burn_uah: Math.round(monthlyBurn / 100),
    monthly_burn_recurring_uah: Math.round(burnShape(levels).recurring / 100),
    runway_months: runwayMonths,
    months_of_history: covered,
    categories: cats.map((c) => {
      const lv = levels.get(c.category_id);
      return {
        id: c.category_id,
        name: c.name,
        avg_month_uah: Math.round(catLevel(c.category_id, c.spent) / 100),
        current_limit_uah: Math.round((currentLimit.get(c.category_id) ?? 0) / 100),
        // How many of the covered months this category was charged in at all. Two out of six is
        // a quarterly bill wearing a monthly average; six out of six is a monthly cost.
        active_months: lv?.active_months ?? null,
        // §BURN-SHAPE's own verdict, so the plan and the burn breakdown cannot disagree.
        lumpy: lv?.lumpy ?? null,
        // A stable, repeating cost (rent, a subscription): the level IS the next bill.
        fixed: lv?.fixed ?? null,
      };
    }),
  };

  const { result, usage } = await proposeBudgetLimits(env, payload);
  logUsage("budget-plan", usage);
  const byId = new Map(result.proposals.map((p) => [p.category_id, p]));

  const rows: BudgetProposalRow[] = cats.map((c) => {
    const p = byId.get(c.category_id);
    const avgMonth = catLevel(c.category_id, c.spent);
    return {
      category_id: c.category_id,
      name: c.name,
      color: c.color,
      avg_month: avgMonth,
      current_limit: currentLimit.get(c.category_id) ?? 0,
      suggested: p ? Math.round(p.limit_uah * 100) : avgMonth,
      reason: p?.reason ?? "",
    };
  });

  return { rows, overall: result.overall, runway_months: runwayMonths, generated_at: now };
}

// §3: діалоговий бюджет — будуємо контекст (категорії з avg/ліміт/вагомість) і ведемо чат.
export async function budgetChatReply(env: Env, messages: ChatMsg[]): Promise<BudgetChatResult & { usage: AiUsageBrief }> {
  const loc = await resolveLocale(env);
  const now = Math.floor(Date.now() / 1000);
  const from90 = now - 90 * 86400;
  const rates = await getRates(env);
  const { mult } = valueMode(rates, null);
  const [ownFunds, spendRows, budgetRows] = await Promise.all([
    ownFundsUAH(env, rates),
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, ${catNameSql(loc, EFF_CAT_NAME)} AS name, ${amountSum(mult)} AS spent, ${EFF_IMPORTANCE} AS importance
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND ${SPEND_WHERE} AND ${EFF_CAT_ID} IS NOT NULL
       GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC LIMIT 14`,
    ).bind(from90).all<{ id: number; name: string; spent: number; importance: string }>(),
    env.DB.prepare("SELECT category_id, amount FROM budgets WHERE period = 'month'").all<{ category_id: number; amount: number }>(),
  ]);
  const limit = new Map<number, number>();
  for (const b of budgetRows.results ?? []) if (b.category_id != null) limit.set(b.category_id, b.amount);
  const cats = spendRows.results ?? [];
  const levels = await categoryMonthlyLevels(env, mult, { now });
  const catLevel = (id: number, spent90: number) => levels.get(id)?.level ?? Math.round(spent90 / 3);
  // P1: burn = сума канонічних місячних рівнів (узгоджено з порадником/патернами).
  const monthlyBurn = sumLevels(levels);

  const ctx = {
    situation: (await getProfile(env)) || "(not specified)",
    own_funds_uah: Math.round(ownFunds / 100),
    monthly_burn_uah: Math.round(monthlyBurn / 100),
    categories: cats.map((c) => ({
      id: c.id, name: c.name, importance: c.importance,
      avg_month_uah: Math.round(catLevel(c.id, c.spent) / 100),
      current_limit_uah: Math.round((limit.get(c.id) ?? 0) / 100),
    })),
  };

  const { result, usage } = await budgetChat(env, ctx, messages);
  logUsage("budget-chat", usage);
  return { ...result, usage: briefUsage(usage) };
}

