// Response shapes of `/api/rules/*` — the deterministic categorisation layer.
// See `./analytics.ts` for why this file exists.

/** `mcc` matches the bank's category code exactly; `text` is a substring of merchant + comment. */
export type RuleMatchType = "mcc" | "text";

export interface RuleRow {
  id: number;
  match_type: string;
  pattern: string;
  category_id: number;
  priority: number;
  category_name: string | null;
  category_color: string | null;
}

/**
 * `POST /rules/preview` — what this rule would have done to the operations already stored.
 *
 * `n_uncategorised` is separate on purpose: it is the only subset an apply may touch, so the
 * screen can say "12 matches, 5 of them still uncategorised" instead of implying it will rewrite
 * everything it found.
 */
export interface RulePreview {
  n: number;
  n_uncategorised: number;
  samples: { id: string; merchant: string | null; time: number }[];
}

/** `POST /rules/:id/apply` — how many previously uncategorised operations were filed. */
export interface RuleApplyResult { ok: boolean; updated: number }
