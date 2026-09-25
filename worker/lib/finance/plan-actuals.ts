/**
 * «Факт проти плану» — what each active plan has ACTUALLY been charged, and what state its latest
 * cycle is in (§PLAN-STATE).
 *
 * Split out of `plan-match.ts` on 2026-09-25 under lint C3, and the seam is a real one: that file
 * answers «which operation IS this plan» and writes `planned_id`; this one only reads the links it
 * produced and summarises them for the Subscriptions list and the feed's plan drafters. Re-exported
 * from `subscriptions.ts`, so no import list changed.
 *
 * The shape is declared ONCE, in `shared/types.ts` (the route `satisfies` it). It used to be
 * declared in `plan-match.ts` as well, field for field — two definitions that agreed by luck.
 */
import type { AppDb } from "../platform/db-shim.ts";
import type { PlannedActual } from "../../../shared/types.ts";
import { planState, type LinkedCharge, type PlanScheduleLike } from "./plan-state.ts";

export type { PlannedActual } from "../../../shared/types.ts";

// §Хвіст: факт vs план по підписках. Для кожної активної підписки рахуємо ФАКТИЧНІ
// списання, прив'язані до неї (planned_id), останню суму/дату та ознаку подорожчання
// (остання сума помітно > оголошеної period_amount). Дає відповісти «скільки реально
// плачу» і «підписка подорожчала?». Без AI — просто агрегація по linked транзакціях.

export async function plannedActuals(db: AppDb): Promise<PlannedActual[]> {
  const now = Math.floor(Date.now() / 1000);
  const subs = await db.prepare(
    `SELECT id, period_amount, currency_code, period, period_count, start_date, end_date, is_active
     FROM planned_payments WHERE is_active = 1`,
  ).all<PlanScheduleLike & { id: number }>();
  // ONE grouped query instead of two per plan (2026-08-27). With a dozen subscriptions that was
  // 24 round trips to answer a question about a single table — and this runs on every open of the
  // Subscriptions page and inside `dead_sub` drafting.
  const agg = await db.prepare(
    `SELECT t.planned_id AS id, COUNT(*) AS n,
            MAX(t.time) AS last_time,
            (SELECT ABS(x.amount) FROM transactions x
             WHERE x.planned_id = t.planned_id AND x.amount < 0 AND x.is_transfer = 0
             ORDER BY x.time DESC LIMIT 1) AS last_amount,
            (SELECT x.currency_code FROM transactions x
             WHERE x.planned_id = t.planned_id AND x.amount < 0 AND x.is_transfer = 0
             ORDER BY x.time DESC LIMIT 1) AS currency_code
     FROM transactions t
     WHERE t.planned_id IS NOT NULL AND t.amount < 0 AND t.is_transfer = 0
     GROUP BY t.planned_id`,
  ).all<{ id: number; n: number; last_time: number; last_amount: number; currency_code: number }>();
  const byId = new Map((agg.results ?? []).map((r) => [r.id, r]));
  // §PLAN-STATE needs the charges themselves, not only the last one: «missing» is two cycles in a
  // row with nothing, which one MAX() cannot tell apart from «paid last month». One query for all
  // plans, bounded to ~13 months — past the deepest walk `planState` does for a quarterly plan.
  const recent = await db.prepare(
    `SELECT planned_id AS id, time, ABS(amount) AS amount, currency_code FROM transactions
     WHERE planned_id IS NOT NULL AND amount < 0 AND is_transfer = 0 AND time >= ?`,
  ).bind(now - 400 * 86400).all<{ id: number } & LinkedCharge>();
  const chargesById = new Map<number, LinkedCharge[]>();
  for (const r of recent.results ?? []) {
    const list = chargesById.get(r.id) ?? [];
    list.push({ time: r.time, amount: r.amount, currency_code: r.currency_code });
    chargesById.set(r.id, list);
  }

  const out: PlannedActual[] = [];
  for (const s of subs.results ?? []) {
    const a = byId.get(s.id);
    const last = a ? { amount: a.last_amount, time: a.last_time, currency_code: a.currency_code } : null;
    const lastAbs = last ? Math.abs(last.amount) : null;
    // Подорожчання рахуємо лише коли є план і фактична сума (в тій самій валюті-порядку).
    const pct = lastAbs != null && s.period_amount && s.period_amount > 0
      ? Math.round(((lastAbs - s.period_amount) / s.period_amount) * 100)
      : null;
    out.push({
      id: s.id,
      count: a?.n ?? 0,
      last_amount: lastAbs,
      last_time: last?.time ?? null,
      currency_code: last?.currency_code ?? null,
      price_change_pct: pct,
      state: planState(s, chargesById.get(s.id) ?? [], now),
    });
  }
  return out;
}
