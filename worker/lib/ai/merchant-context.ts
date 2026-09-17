/**
 * §MERCH-QUIET — how a merchant is described to the model in the finance snapshot.
 *
 * THE BUG (2026-09-15): a feed card said «You spend 1293 ₴/month on Preply» two and a half months
 * after the user stopped paying Preply. The snapshot handed the model `per_month_90d_uah` — the
 * 90-day total over three — and two June charges were still inside the window, so the "monthly"
 * figure described a habit that had already ended. A note in the payload warned the model about
 * that figure; the model used it anyway, and `numbersAreGrounded` let it through because the
 * number really was in the snapshot.
 *
 * THE FIX IS TO NOT STATE IT: a merchant whose last charge is older than `QUIET_AFTER_DAYS` gets
 * no monthly figure at all, only its 90-day total and how long ago it was last paid. With the
 * number absent from the snapshot, the grounding check rejects any sentence that repeats it —
 * a deterministic guard instead of one more line of prompt (§Rules: a check beats an instruction).
 *
 * Why 45 days: a monthly charge that has not recurred in a month and a half has missed a cycle.
 * A quarterly merchant is hidden by this too — acceptable, because a quarterly payment divided
 * by three was never a "per month" anyone pays either.
 */
export const QUIET_AFTER_DAYS = 45;

export interface MerchantRow { merchant: string; spent: number; last_at: number }

export interface MerchantContext {
  merchant: string;
  spent_90d_uah: number;
  last_paid_days_ago: number;
  per_month_90d_uah?: number;   // present only while the merchant is still being paid
  stopped?: true;
}

export function merchantContext(rows: MerchantRow[], now: number): MerchantContext[] {
  return rows.map((m) => {
    const daysAgo = Math.max(0, Math.floor((now - m.last_at) / 86400));
    const quiet = daysAgo > QUIET_AFTER_DAYS;
    return {
      merchant: m.merchant,
      spent_90d_uah: Math.round(m.spent / 100),
      last_paid_days_ago: daysAgo,
      ...(quiet ? { stopped: true as const } : { per_month_90d_uah: Math.round(m.spent / 3 / 100) }),
    };
  });
}
