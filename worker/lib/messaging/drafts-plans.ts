/**
 * `drafts-plans` — WHAT CHANGED ABOUT A PLAN the user already declared: a subscription whose price
 * moved (§PRICE-STEPS) and one that has stopped being charged at all.
 *
 * Split out of `notify.ts` on 2026-09-18 under lint C3, the same way `drafts-due.ts` was split the
 * week before: that file sits at its size exception, an exception may never RISE, and a new
 * notification kind had nowhere to land. The seam is a real one rather than a slice of whatever
 * was at the bottom of the file — both drafters here read `plannedActuals()` against
 * `planned_payments` and both answer «the plan you declared and the charges we see disagree»,
 * which is a different question from «money leaves on a date» (`drafts-due`) and from «your month
 * is going badly» (the pace drafters that stayed behind).
 *
 * They keep SEPARATE preferences (`price_up`, `dead_sub`) because they are separate facts: one
 * costs money and one saves it, and muting «this got more expensive» says nothing about wanting
 * to hear «you are paying for something that never charges».
 */
import type { Env } from "../../env.ts";
import { getRates } from "../finance/money.ts";
import { plannedActuals, plannedUAH } from "../finance/subscriptions.ts";
import { localYmd } from "../finance/stats.ts";
import type { Draft } from "./notify.ts";

// The same one-liner every sibling drafter keeps (`drafts-due.ts`, `drafts-ai.ts`): a dedup key
// needs a Kyiv calendar day, and importing one another's private helper would couple files that
// otherwise share nothing.
const isoDay = (unix: number) => localYmd(unix);

/** Подорожчання підписки: остання фактична сума помітно вища за план (plannedActuals). */
export async function draftPriceUps(env: Env): Promise<Draft[]> {
  const [actuals, plans] = await Promise.all([
    plannedActuals(env.DB),
    env.DB.prepare("SELECT id, title, period_amount FROM planned_payments WHERE is_active = 1")
      .all<{ id: number; title: string; period_amount: number | null }>(),
  ]);
  const titleById = new Map((plans.results ?? []).map((p) => [p.id, p]));

  const out: Draft[] = [];
  for (const a of actuals) {
    if (a.price_change_pct == null || a.price_change_pct < 10) continue;
    const p = titleById.get(a.id);
    if (!p || !p.period_amount || a.last_amount == null || a.last_time == null) continue;
    const delta = a.last_amount - p.period_amount;
    if (delta <= 0) continue;
    out.push({
      kind: "price_up",
      // Абсолютна дельта + вплив на рік читається краще за голий відсоток (як у Підписках).
      tkey: "price_up",
      tparams: {
        title: p.title, pct: a.price_change_pct,
        old: p.period_amount, new: a.last_amount, delta, year: delta * 12,
      },
      severity: "warn",
      entity_type: "planned", entity_id: String(a.id),
      dedup_key: `price_up:${a.id}:${isoDay(a.last_time)}`,
    });
  }
  return out;
}

/** «Мертва» підписка: активна понад 60 днів, а жодного фактичного списання не видно. */
export async function draftDeadSubs(env: Env, now: number): Promise<Draft[]> {
  const [actuals, plans] = await Promise.all([
    plannedActuals(env.DB),
    env.DB.prepare(
      "SELECT id, title, period_amount, currency_code, start_date FROM planned_payments WHERE is_active = 1",
    ).all<{ id: number; title: string; period_amount: number | null; currency_code: number | null; start_date: number }>(),
  ]);
  const rates = await getRates(env);
  const countById = new Map(actuals.map((a) => [a.id, a.count]));

  const out: Draft[] = [];
  for (const p of plans.results ?? []) {
    if (now - p.start_date < 60 * 86400) continue;   // ще молода — рано судити
    if ((countById.get(p.id) ?? 0) > 0) continue;    // списання бачимо
    const perMonth = plannedUAH(p.period_amount, p.currency_code, rates);
    out.push({
      kind: "dead_sub",
      tkey: "dead_sub",
      tparams: { title: p.title, perMonth },
      severity: "info",
      entity_type: "planned", entity_id: String(p.id),
      dedup_key: `dead_sub:${p.id}:${isoDay(now).slice(0, 7)}`,   // раз на місяць
    });
  }
  return out.slice(0, 3);
}
