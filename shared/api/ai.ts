// Response shapes of the AI surface: `/api/advisor/*`, `/api/insight/*`, `/api/reports/*`,
// `/api/jobs/*`, `/api/facts/*`, `/api/knowledge/*`.
// See `./analytics.ts` for why this file exists.
//
// ⚠️ These shapes describe what the SERVER sends, which is not always what the model produced:
// several of them are assembled deterministically from our own numbers and only carry an AI note
// (`FinancialReport.categories`, `.trend`, `.importance`). A section we compute ourselves must
// never be gated on an array the model returned — that bug is recorded in CLAUDE.md.

export interface AiFact {
  label: string;
  amount?: number | null;    // грн (major)
  category?: string | null;
  delta_pct?: number | null;
  tone?: "pos" | "neg" | "neutral" | null;
}
export interface AdviceAction {
  type: "create_budget";
  label: string;
  category_id?: number | null;
  category_name?: string | null;
  amount_uah?: number | null;
}
/** Token counts of the call behind a user-facing answer (the cost meter is `AiUsageStats`). */
export interface AiUsageBrief { in: number; out: number; cache_read: number }

export interface Advice {
  runway_comment: string;
  summary: string;
  facts?: AiFact[];
  suggestions: { title: string; detail: string; action?: AdviceAction | null }[];
  own_funds: number;
  cushion: number;
  debt: number;
  investment?: number;
  monthly_burn: number;
  runway_months: number | null;
  usage?: AiUsageBrief;
  generated_at: number;
  /**
   * §BASE-CUR — the currency every figure here is in, stamped at generation. Advice is stored and
   * re-read for a month, so it must be signed with its OWN unit; absent = written before the
   * setting existed, which means hryvnia.
   */
  cur?: number;
  /** Порада зібрана детерміновано з чисел, без AI (ключ/ліміт/збій моделі). */
  fallback?: boolean;
  fallback_reason?: string;
}
export interface AdviceHistoryItem {
  generated_at: number; summary: string; runway_months: number | null; monthly_burn: number; own_funds: number;
  cushion?: number;
  /** §BASE-CUR — see `Advice.cur`. A delta against a snapshot in a DIFFERENT currency is not a delta. */
  cur?: number;
}

export interface StructuredInsight {
  headline: string;
  facts: AiFact[];
  note?: string | null;
}
export interface Insight {
  text: string;
  structured?: StructuredInsight;
  usage?: AiUsageBrief;
  generated_at: number;
  period_from: number;
  period_to: number;
  period_days: number;
  /** §BASE-CUR — the currency `structured.facts` are in, stamped at generation. See `Advice.cur`. */
  cur?: number;
  empty?: boolean;
}

// §Аналітика 2.0 — AI-репорти.
export interface FinancialReport {
  headline: string;
  summary: string;
  sections: { title: string; body: string }[];
  category_breakdown: { name: string; amount_uah: number; delta_pct: number | null; note: string | null }[];
  anomalies: { label: string; detail: string; severity: "info" | "warn" | "high" }[];
  predictions: { next_period_spend_uah: number | null; runway_months: number | null; note: string | null };
  advice: { title: string; detail: string; action?: AdviceAction | null }[];
  trend?: { month: string; spend_uah: number; income_uah: number }[]; // §5: детерміновані дані для лінії
  importance?: { level: string; amount_uah: number; pct: number }[]; // §6: детермінована розбивка вагомості
  // §R6: детерміновані категорії (надійні суми + дельта + prev) з приклеєною AI-нотаткою.
  categories?: { name: string; amount_uah: number; prev_uah: number; delta_pct: number | null; note?: string | null }[];
  /**
   * §BASE-CUR — the currency EVERY figure above is in, stamped when the report was generated.
   * Absent on reports written before the display currency existed; those are hryvnia.
   * The page must sign its numbers with this, not with the currency selected today.
   */
  cur?: number;
}
export type ReportPeriodType = "week" | "month" | "custom";
export interface ReportListItem {
  id: number; period_type: ReportPeriodType; period_from: number; period_to: number;
  created_at: number; model: string | null; cost_usd: number | null; summary: string | null;
}
export interface ReportFull extends ReportListItem { data: FinancialReport }

// §A6 — фонова AI-генерація. Дзеркалить рядок `ai_jobs` у БД юзера.
export type AiJobKind = "advisor" | "report" | "budget";
export interface AiJob {
  id: number;
  kind: AiJobKind;
  status: "queued" | "running" | "done" | "failed";
  result_json: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  seen_at: number | null;
}

// §A1: факт про світ. adjust_* рухає числа лише коли confirmed_at != null (гейт підтвердження).
export interface Fact {
  id: number; text: string; effective_from: number; expires_at: number | null;
  category_id: number | null; category_name: string | null;
  adjust_kind: "multiplier" | "delta_minor" | null; adjust_value: number | null;
  confirmed_at: number | null; source: string; created_at: number;
}
export interface FactInput {
  text: string; effective_from?: number; expires_at?: number | null;
  category_id?: number | null; adjust_kind?: "multiplier" | "delta_minor" | null;
  adjust_value?: number | null; confirm?: boolean;
}

// §A5: документ корпусу знань. `builtin` — заводський (може бути переписаний або вимкнений,
// крім `locked`); `user` — власна нотатка користувача.
export interface KnowledgeMeta {
  id: string; title: string; summary: string; chars: number;
  kind: "builtin" | "user"; locked: boolean; enabled: boolean; overridden: boolean; updated_at: number | null;
}
export interface KnowledgeList { docs: KnowledgeMeta[]; user_chars: number; user_limit: number; doc_limit: number }
export interface KnowledgeDocFull { id: string; title: string; summary: string; body: string; kind: "builtin" | "user"; locked: boolean; enabled: boolean; overridden: boolean }

export type AiTask = "report" | "advisor" | "insight" | "chat" | "budget" | "group" | "notify";
export type AiModelToken = "haiku" | "sonnet" | "opus";

/**
 * §AI-AUDIT (migration 0041) — one field the model rewrote on a transaction.
 *
 * `old_value` is what makes this an undo rather than a log. `NULL` in it is a real previous value
 * ("had no category"), not a missing one, which is why every value is stored as text: the three
 * audited columns have three different types and one nullable string carries all of them without
 * a per-field shape.
 */
export interface AiChange {
  id: number;
  tx_id: string;
  field: string;            // 'category_id' | 'is_transfer' | 'ai_note'
  old_value: string | null;
  new_value: string | null;
  source: string;           // 'enrich' | 'chat' | 'resweep'
  created_at: number;
  /** Set once the user put the old value back. The row stays — see `repo/ai-changes.ts`. */
  reverted_at: number | null;
  /** Only on the cross-transaction list, so a row reads on its own. */
  merchant?: string | null;
}
