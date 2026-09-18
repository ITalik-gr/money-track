/**
 * §TAX-DUE — the figures a THIRD PARTY checks: one row per quarter of a tax year.
 *
 * Split from `business.ts` the moment it pushed that file over C3's 400 lines, and the seam is the
 * one the code already drew for itself: everything in `business.ts` reads the LEDGER and answers a
 * question for the owner's own screen; this reads the STORED OBLIGATIONS and answers a question an
 * accountant or an inspector will ask. Those are different sources of truth, and the difference is
 * the whole value of the summary.
 *
 * ⚠️ Nothing here is recomputed. An obligation that has been paid keeps the amount it was paid at
 * (§TAX-DUE, §BUDGET-MEMORY); re-deriving it would silently re-price a closed quarter with today's
 * rate table, and a summary that cannot be reconciled with what was actually filed is worse than
 * no summary — it is a second, plausible set of numbers.
 */
import type { AppDb } from "../platform/db-shim.ts";
import * as taxRepo from "../../repo/tax.ts";
import { quarterWindow } from "./tax.ts";

export interface QuarterSummaryRow {
  quarter: string;
  /** ₴ minor, from the frozen tax base (§TAX-FX). */
  income: number;
  receipts: number;
  single_tax: number;
  military_levy: number;
  social_contribution: number;
  /** What has actually been paid against that quarter's obligations. */
  paid: number;
  outstanding: number;
}

/**
 * One row per quarter of a tax YEAR — the summary an accountant asks for after the ledger.
 *
 * ⚠️ Read from the STORED obligations, not recomputed. The ledger says what came in; this says
 * what was accrued and what was settled, and those are facts with a history: an obligation that
 * was paid keeps the amount it was paid at (§TAX-DUE, §BUDGET-MEMORY). Recomputing it here would
 * quietly re-price a closed quarter with today's rate table — and the whole point of a summary is
 * that it can be checked against what was actually filed.
 *
 * ⚠️ Every quarter of the year is present, including empty ones. A missing Q1 reads as «no data»,
 * and an accountant cannot tell that apart from «we have not looked».
 */
export async function quarterSummary(db: AppDb, year: number): Promise<QuarterSummaryRow[]> {
  const obligations = await taxRepo.listObligations(db, `${year}-01`);
  const out: QuarterSummaryRow[] = [];
  for (let q = 1; q <= 4; q++) {
    const label = `${year}-Q${q}`;
    // `quarterWindow` and not a second (year, q) → midnights calculation: «which window is Q3»
    // already has an owner, and the two would drift the first time either was edited (§APP_TZ).
    const { from, to } = quarterWindow(label);
    const inc = await taxRepo.businessIncome(db, from, to);
    // The quarter's own rows, plus the MONTHLY rows of its three months: groups 1–2 accrue per
    // month, so a quarterly summary that only looked at 'YYYY-Qn' would report them as zero.
    const months = [0, 1, 2].map((k) => `${year}-${String(q * 3 - 2 + k).padStart(2, "0")}`);
    const mine = obligations.filter((o) => o.period === label || months.includes(o.period));
    const sum = (kind: string) => mine.filter((o) => o.kind === kind).reduce((n, o) => n + o.amount, 0);
    const paid = mine.filter((o) => o.paid_tx_id).reduce((n, o) => n + o.amount, 0);
    const total = mine.reduce((n, o) => n + o.amount, 0);
    out.push({
      quarter: label,
      income: inc.base_uah,
      receipts: inc.n,
      single_tax: sum("single_tax"),
      military_levy: sum("military_levy"),
      social_contribution: sum("social_contribution"),
      paid,
      outstanding: total - paid,
    });
  }
  return out;
}
