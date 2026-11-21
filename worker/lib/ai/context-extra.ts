/**
 * §CTX-EXTRA — what the app already stores but the assistant was never shown.
 *
 * Each block closes a gap seen in real answers: goals were invisible, the credit card's terms were
 * in `accounts` while the model guessed them, a hand-edited balance looked as fresh as a bank feed,
 * and a monthly payment with no plan had no presence in «what is coming».
 */
import type { Env } from "../../env.ts";
import type { Rates } from "../finance/money.ts";
import { toBaseMinor } from "../finance/money.ts";
import { STATS_JOINS, SPEND_WHERE, amountSum, localMonthStart, localYmSql, localYmd, valueMode } from "../finance/stats.ts";
import { resolveLocale } from "../platform/i18n.ts";
import { incomeBySource } from "../../repo/income.ts";
import { memoryContext } from "./memory.ts";

const DAY = 86400;
const whole = (minor: number) => Math.round(minor / 100);

export async function extraContext(env: Env, now: number, rates: Rates): Promise<Record<string, unknown>> {
  const { mult } = valueMode(rates, null);
  const loc = await resolveLocale(env);
  const [goals, accounts, plans, repeating, income, memory] = await Promise.all([
    env.DB.prepare(
      `SELECT g.name, g.kind, g.target_amount AS target, COALESCE(a.balance, g.current_amount) AS saved,
              COALESCE(a.currency_code, g.currency_code, 980) AS cur, g.deadline
       FROM savings_goals g LEFT JOIN accounts a ON a.id = g.account_id WHERE g.is_active = 1 LIMIT 10`,
    ).all<{ name: string; kind: string; target: number; saved: number; cur: number; deadline: number | null }>(),
    env.DB.prepare(
      `SELECT title, balance, credit_limit, currency_code, statement_day, payment_day, min_payment, is_manual, updated_at
       FROM accounts WHERE is_active = 1`,
    ).all<{ title: string | null; balance: number; credit_limit: number | null; currency_code: number; statement_day: number | null; payment_day: number | null; min_payment: number | null; is_manual: number; updated_at: number | null }>(),
    env.DB.prepare("SELECT title FROM planned_payments WHERE is_active = 1").all<{ title: string }>(),
    env.DB.prepare(
      `SELECT t.merchant AS merchant, COUNT(DISTINCT ${localYmSql(now)}) AS months, COUNT(DISTINCT t.id) AS n,
              ${amountSum(mult)} AS spent, MAX(t.time) AS last_at
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND ${SPEND_WHERE} AND t.merchant IS NOT NULL
       GROUP BY t.merchant HAVING months >= 2 AND n <= months + 1 ORDER BY spent DESC LIMIT 12`,
    ).bind(localMonthStart(now, -3)).all<{ merchant: string; months: number; n: number; spent: number; last_at: number }>(),
    incomeBySource(env.DB, loc, { mult, curFilter: "" }, { from: now - 90 * DAY, to: now }),
    memoryContext(env, now),
  ]);

  const out: Record<string, unknown> = { ...memory };
  const base = (minor: number, cur: number) => whole(toBaseMinor(minor, cur, rates));

  const goalRows = (goals.results ?? []).map((g) => ({
    name: g.name, kind: g.kind, saved_uah: base(g.saved, g.cur), target_uah: base(g.target, g.cur),
    ...(g.deadline ? { deadline: localYmd(g.deadline) } : {}),
  }));
  if (goalRows.length) out.goals = goalRows;

  const credit = (accounts.results ?? []).filter((a) => (a.credit_limit ?? 0) > 0).map((a) => ({
    account: a.title, limit_uah: base(a.credit_limit ?? 0, a.currency_code), available_uah: base(Math.max(0, a.balance), a.currency_code),
    ...(a.statement_day ? { statement_day: a.statement_day } : {}),
    ...(a.payment_day ? { payment_day: a.payment_day } : {}),
    ...(a.min_payment ? { min_payment_uah: base(a.min_payment, a.currency_code) } : {}),
  }));
  if (credit.length) out.credit_lines = credit;

  const manual = (accounts.results ?? []).filter((a) => a.is_manual && a.updated_at)
    .map((a) => ({ account: a.title, updated_days_ago: Math.floor((now - (a.updated_at as number)) / DAY) }));
  if (manual.length) {
    out.manual_balances = manual;
    out.manual_balances_note = "These balances are typed by hand and are only as fresh as updated_days_ago. For a volatile asset, say the value is as of that day.";
  }

  const sources = income.slice(0, 6).map((s) => ({ source: s.name, amount_90d_uah: whole(s.amount), operations: s.n }));
  if (sources.length) out.income_sources_90d = sources;

  const planned = (plans.results ?? []).map((p) => p.title.trim().toLowerCase()).filter((t) => t.length >= 3);
  const unplanned = (repeating.results ?? [])
    .filter((r) => { const m = r.merchant.trim().toLowerCase(); return !planned.some((t) => m.includes(t) || t.includes(m)); })
    .slice(0, 4)
    .map((r) => ({ merchant: r.merchant, typical_uah: whole(Math.abs(r.spent) / r.n), months_seen: r.months, last_paid_days_ago: Math.floor((now - r.last_at) / DAY) }));
  if (unplanned.length) {
    out.repeating_without_plan = unplanned;
    out.repeating_without_plan_note = "Charges that repeat monthly but have no scheduled plan, so they are absent from upcoming_charges and have NO known date. Do not state a due date from this list. Remember them when judging what the next weeks must cover, and if one is large, suggest adding it as a planned payment.";
  }
  return out;
}
