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
/**
 * §ADVICE-LOOP — what a suggestion can DO, beyond being read.
 *
 * ⚠️ **Every variant here must have an executor that already exists behind an endpoint.** Until
 * 2026-09-04 there was exactly one (`create_budget`), so four of the adviser's five steps were
 * prose that led nowhere — and the fix is not to invent more buttons but to name the actions the
 * app can already carry out. A variant with no executor is a button that lies, which is worse than
 * a paragraph that is honest about being a paragraph.
 */
export type AdviceActionType =
  | "create_budget"        // → POST /budgets            (setBudget)
  | "set_budget"           // → POST /budgets            (setBudget, on a category that has one)
  | "create_goal"          // → POST /goals              (createGoal)
  | "cancel_subscription"  // → DELETE /planned/:id      (deletePlanned)
  | "create_rule";         // → POST /rules              (createRule)

export interface AdviceAction {
  type: AdviceActionType;
  label: string;
  category_id?: number | null;
  category_name?: string | null;
  /** `create_budget` / `set_budget`: the limit. `create_goal`: the target. Whole hryvnia. */
  amount_uah?: number | null;
  /** `create_goal` — what the goal is called. */
  goal_title?: string | null;
  /** `cancel_subscription` — the plan to end. Resolved server-side; the model never invents an id. */
  planned_id?: number | null;
  planned_title?: string | null;
  /** `create_rule` — the substring to match against a merchant. */
  match_pattern?: string | null;
}

/**
 * §ADVICE-LOOP — where a suggestion stands. `open` is the absence of a decision, not a state the
 * user sets: a suggestion nobody has touched has to be distinguishable from one they rejected,
 * or the next generation cannot tell «not seen» from «not wanted».
 */
export type SuggestionState = "open" | "taken" | "done" | "dismissed";

/**
 * §ADVICE-LOOP — one suggestion, with an identity that survives re-generation.
 *
 * ⚠️ **`key` is derived from the TITLE, never from a position in the array.** `advice-history.ts`
 * already learned this for snapshots («an index would shift under a concurrent delete from another
 * device»), and here it is worse: advice is regenerated wholesale, so an index means the state the
 * user set on suggestion #2 lands on whatever the model happens to put second next time.
 * ⚠️ A rephrased title IS a new suggestion as far as this can tell. That is honest rather than
 * clever — and it is also why the previous titles are handed to the model (§NOVELTY): the way to
 * stop a rephrase is to show what was already said, not to guess at synonyms.
 */
export interface AdviceSuggestion {
  key: string;
  title: string;
  detail: string;
  action?: AdviceAction | null;
  state: SuggestionState;
  /** When the state was last set. Absent while `open`. */
  state_at?: number | null;
  /**
   * §ADVICE-LOOP — the figure this suggestion was about, captured when it was made, so a taken one
   * can be scored later against the SAME figure. Only set where the app can measure it.
   */
  metric?: SuggestionMetric | null;
  /** Filled once there is a month to compare against. Computed from the ledger, never asserted. */
  outcome?: SuggestionOutcome | null;
}

/** The one measurable shape so far: a category's canonical monthly level (§LEVEL-WINDOW). */
export interface SuggestionMetric {
  kind: "category_month";
  category_id: number;
  category_name: string;
  /** The level at the moment the advice was written, ₴ minor in the base of that day. */
  baseline: number;
  at: number;
}

export interface SuggestionOutcome {
  /** Negative = the category costs less than when the advice was written. */
  delta_pct: number;
  current: number;
  measured_at: number;
}
/** Token counts of the call behind a user-facing answer (the cost meter is `AiUsageStats`). */
export interface AiUsageBrief { in: number; out: number; cache_read: number }

export interface Advice {
  runway_comment: string;
  summary: string;
  facts?: AiFact[];
  /**
   * §ADVICE-LOOP — carries state and identity since 2026-09-04. Advice generated before that has
   * plain `{title, detail, action}` objects; readers must tolerate a missing `state`/`key`, which
   * `normaliseSuggestions` does on the way out so no component has to.
   */
  suggestions: AdviceSuggestion[];
  own_funds: number;
  cushion: number;
  debt: number;
  investment?: number;
  monthly_burn: number;
  /**
   * §BURN-SHAPE — the SAME burn, split into the half that repeats and the half that does not.
   * `recurring + lumpy === monthly_burn`; they are parts of it, never additions to it. Absent on
   * advice generated before 2026-08-27.
   */
  burn_recurring?: number;
  burn_lumpy?: number;
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
