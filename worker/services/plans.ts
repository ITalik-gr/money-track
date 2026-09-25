// Plan scenarios. Creating a plan is three steps whose ORDER is the behaviour — validate, derive an
// installment's end, write, then attach the history the plan describes — and the route only words
// the outcome (moved out of `routes/api/planned.ts` on 2026-09-25 under C3). A service NAMES an
// error; the route turns it into the reader's language.
import type { AppDb } from "../lib/platform/db-shim.ts";
import * as planningRepo from "../repo/planning.ts";

export interface NewPlanBody {
  title: string; kind: "subscription" | "installment" | "income"; total_amount?: number;
  period_amount?: number; period: "month" | "week"; period_count?: number; start_date: number;
  category_id?: number; account_id?: string; currency_code?: number; amount_varies?: boolean;
}

export async function createPlan(
  db: AppDb, b: NewPlanBody,
): Promise<{ error: "income_amount" } | { id: number; occurrences: number | null; end_date: number | null; linked: number }> {
  // §INCOME-PLAN: an expected inflow is the same schedule with the sign flipped, so it reuses
  // everything here. `amount_varies` only marks the figure as an ESTIMATE — the owner's actual
  // constraint is that income is neither the same size nor on time, and a number presented as
  // exact when it is not is the thing that makes the forecast untrustworthy.
  if (b.kind === "income" && !(b.period_amount && b.period_amount > 0)) return { error: "income_amount" };
  const periodCount = Math.max(1, Math.round(b.period_count ?? 1)); // «кожні N періодів» (§SUB4)
  // Installment auto-math (§6.5): derive occurrences/end_date from total & per-period.
  let occurrences: number | null = null;
  let end_date: number | null = null;
  if (b.kind === "installment" && b.total_amount && b.period_amount) {
    occurrences = Math.ceil(b.total_amount / b.period_amount);
    const step = (b.period === "week" ? 7 * 86400 : 30 * 86400) * periodCount;
    end_date = b.start_date + occurrences * step;
  }
  const id = await planningRepo.create(db, {
    title: b.title, kind: b.kind,
    total_amount: b.total_amount ?? null, period_amount: b.period_amount ?? null,
    period: b.period, period_count: periodCount, start_date: b.start_date,
    end_date, occurrences,
    category_id: b.category_id ?? null, account_id: b.account_id ?? null,
    currency_code: b.currency_code ?? 980,
    amount_varies: !!b.amount_varies,
  });
  // §PLAN-LINK: a plan is declared BECAUSE it has been charging for a while, so the history it
  // describes already exists. Without this the plan opened with zero charges and every screen said
  // «списань не видно» about a subscription paid every month — see `linkPlanHistory`.
  // ⚠️ An income plan has no outflow to link, and linking is best-effort: failing to attach the
  // past must not fail the creation the user asked for.
  let linked = 0;
  if (b.kind !== "income") {
    try {
      const { linkPlanHistoryById } = await import("../lib/finance/subscriptions.ts");
      linked = (await linkPlanHistoryById(db, id)).linked;
    } catch { /* the plan exists; the back-link can be redone from Settings */ }
  }
  return { id, occurrences, end_date, linked };
}
