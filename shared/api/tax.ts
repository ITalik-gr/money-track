/**
 * `/tax/*` — ФОП obligations, the reserve, the annual limit (docs/TAX.md).
 *
 * ⚠️ §TAX-UAH: every amount in this file is HRYVNIA minor units, regardless of the reader's base
 * currency. The state levies in hryvnia; a tax figure converted into the display base would be a
 * number that exists on no document. The client renders these with an explicit ₴, never `baseSign()`.
 */

export type TaxGroup = 1 | 2 | 3;
export type ObligationKind = "single_tax" | "military_levy" | "social_contribution";
export type LimitState = "ok" | "projected" | "exceeded";

export interface TaxProfile {
  enabled: boolean;
  group: TaxGroup;
  vat: boolean;
  /** Groups 1–2: the council's rate when it is below the legal maximum. ₴ minor per month. */
  single_override: number | null;
  esv_exempt: boolean;
}

export interface TaxObligation {
  id: number;
  kind: string;
  period: string;
  amount: number;
  due_date: string;
  paid_tx_id: string | null;
  paid_at: number | null;
  overdue: boolean;
}

export interface TaxStatus {
  enabled: boolean;
  profile: TaxProfile;
  /** Accrued and unpaid — the money on the balance that is not the user's. */
  reserved: number;
  next: { id: number; kind: ObligationKind; period: string; amount: number; due_date: string; days_left: number } | null;
  obligations: TaxObligation[];
  limit: { used: number; limit: number; pct: number; state: LimitState; projected_date: string | null };
  quarter: { label: string; income: number; n: number; missing_rate: number };
  /** Foreign-currency receipts still without an official rate (§TAX-FX). */
  missing_rate: number;
}

/**
 * §TAX-DUE — an operation that could be the payment of one obligation.
 *
 * Offered rather than assumed: the app proposes the rows whose amount and date fit, and the human
 * says which one it was. An automatic link would be the app asserting a payment it cannot verify.
 */
export interface TaxPaymentCandidate {
  id: string;
  time: number;
  merchant: string | null;
  /** ₴ minor, as stored: an expense is negative. */
  amount: number;
  category_id: number | null;
}

export interface TaxPaymentCandidates {
  obligation: { id: number; kind: string; period: string; amount: number; due_date: string };
  candidates: TaxPaymentCandidate[];
}

export interface TaxLedgerRow {
  id: string;
  time: number;
  merchant: string | null;
  amount: number;
  currency_code: number;
  tax_base_uah: number | null;
  /** The NBU rate that produced the base, ×10000 — so the figure can be checked, not just read. */
  rate: number | null;
  effective_date: string | null;
}

export interface TaxLedger {
  from: number;
  to: number;
  rows: TaxLedgerRow[];
  total_uah: number;
}

export interface TaxBackfillResult {
  /** Receipts that got a frozen hryvnia base on this pass. */
  filled: number;
  /** Still without one — the NBU was unreachable or the currency is unknown. */
  remaining: number;
}

// ─── the business side (docs/TAX.md §0.1) ───────────────────────────────────────────────────────

export interface TaxCounterparty {
  name: string; total_uah: number; n: number; first_at: number; last_at: number;
}

export interface BusinessQuarter {
  label: string; income: number; tax: number; expenses: number; net: number;
  effective_pct: number | null;
  /** The part of the tax that does NOT move with income — ЄСВ, and the flat ЄП/ВЗ of groups 1–2. */
  fixed: number;
}

export interface BusinessRhythm {
  n: number;
  median_gap_days: number | null;
  days_since_last: number | null;
  avg_uah: number;
}

/** §TAX-LIMIT — what one group would charge for the same quarter, and whether it is even open. */
export interface GroupCost {
  group: 1 | 2 | 3;
  tax: number;
  esv: number;
  total: number;
  annual_limit: number;
  over_limit: boolean;
}

/** §BUDGET-PACE — where the open quarter is heading. `projected_*` is null until the pace means something. */
export interface QuarterOutlook {
  label: string;
  income_so_far: number;
  projected_income: number | null;
  accrued_now: number;
  projected_tax: number | null;
  days_elapsed: number;
  days_left: number;
  groups: GroupCost[];
}

/** §TAX-BASE — a work expense by category root. A REPORT: on the single tax it reduces nothing. */
export interface BusinessExpenseRow {
  category_id: number;
  name: string;
  /** ₴ minor, POSITIVE. */
  uah: number;
  n: number;
}

/** §TAX-DUE meets §RHYTHM: the tax falls due before the receipt that pays it is expected. */
export interface CashGap {
  due_date: string;
  amount: number;
  expected_income: string;
  days_short: number;
}

export interface BusinessOverview {
  outlook: QuarterOutlook;
  costs: BusinessExpenseRow[];
  cash_gap: CashGap | null;
  quarters: BusinessQuarter[];
  counterparties: TaxCounterparty[];
  rhythm: BusinessRhythm;
  year_ago: { label: string; income: number } | null;
  top_share_pct: number | null;
}

// ─── §TAX-WATCH ─────────────────────────────────────────────────────────────────────────────────

export interface RegSource {
  id: number;
  url: string;
  label: string;
  topic: string | null;
  region: string | null;
  last_checked: number | null;
  last_changed: number | null;
  /** Changing on every check: recording continues, alerts stop until a human clears it. */
  noisy: number;
  last_error: string | null;
}

export interface TaxRequisite {
  id: number;
  kind: string;
  iban: string | null;
  recipient: string | null;
  edrpou: string | null;
  purpose: string | null;
  /** When a HUMAN last confirmed this against the source — never when a machine fetched. */
  verified_at: number | null;
  source_id: number | null;
  /** The source moved after that confirmation. THE sentence this whole feature exists to show. */
  stale: boolean;
  source_changed_at: number | null;
}

export interface RegWatch {
  sources: RegSource[];
  requisites: TaxRequisite[];
}
