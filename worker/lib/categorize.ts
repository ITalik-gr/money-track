// Non-AI categorisation (plan §5): learned merchant aliases first, then mcc/text rules.
// Returns the resolved category and a human display name when an alias overrides it.

import { matchActiveSubscription } from "./subscriptions.ts";
import type { AppDb } from "./db-shim.ts";

export interface CategorizeInput {
  mcc: number | null;
  description: string | null;
  amount?: number | null;        // копійки (знак: витрата < 0) — для матчу з підписками
  currency_code?: number | null; // валюта РАХУНКУ операції
}

export interface CategorizeResult {
  category_id: number | null;
  display_name: string | null;
  is_transfer: boolean;
  real_category_id: number | null; // навчена реальна категорія переказу/зняття (§F2 крок 2)
  planned_id: number | null;       // зв'язок із підпискою, якщо операція під неї підпадає (§R5)
}

export async function categorize(
  db: AppDb,
  input: CategorizeInput,
): Promise<CategorizeResult> {
  const desc = (input.description ?? "").trim();

  // 1. Learned merchant aliases — exact raw mono description, then mcc.
  if (desc) {
    const byDesc = await db
      .prepare(
        "SELECT display_name, category_id, is_transfer, real_category_id FROM merchant_aliases WHERE match_type = 'mono_desc' AND raw_key = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(desc)
      .first<{ display_name: string | null; category_id: number | null; is_transfer: number; real_category_id: number | null }>();
    if (byDesc) return { category_id: byDesc.category_id, display_name: byDesc.display_name, is_transfer: !!byDesc.is_transfer, real_category_id: byDesc.real_category_id, planned_id: null };
  }
  if (input.mcc != null) {
    const byMcc = await db
      .prepare(
        "SELECT display_name, category_id, is_transfer, real_category_id FROM merchant_aliases WHERE match_type = 'mcc' AND raw_key = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(String(input.mcc))
      .first<{ display_name: string | null; category_id: number | null; is_transfer: number; real_category_id: number | null }>();
    if (byMcc) return { category_id: byMcc.category_id, display_name: byMcc.display_name, is_transfer: !!byMcc.is_transfer, real_category_id: byMcc.real_category_id, planned_id: null };
  }

  // 1b. Активна підписка (детерміністично, без AI): той самий мерчант+сума+валюта, що
  // й оголошена підписка → її категорія. Раніше AI вгадував це наосліп (Apple $1 → «Розваги»).
  if (input.amount != null && input.amount < 0 && input.currency_code != null) {
    const sub = await matchActiveSubscription(db, {
      merchant: null, description: desc || null, amount: input.amount, currency_code: input.currency_code,
    });
    if (sub) return { category_id: sub.category_id, display_name: null, is_transfer: false, real_category_id: null, planned_id: sub.planned_id };
  }

  // 2. Rules: mcc match, then text substring. Highest priority wins.
  if (input.mcc != null) {
    const r = await db
      .prepare(
        "SELECT category_id FROM rules WHERE match_type = 'mcc' AND pattern = ? ORDER BY priority DESC LIMIT 1",
      )
      .bind(String(input.mcc))
      .first<{ category_id: number }>();
    if (r) return { category_id: r.category_id, display_name: null, is_transfer: false, real_category_id: null, planned_id: null };
  }
  if (desc) {
    const textRules = await db
      .prepare(
        "SELECT pattern, category_id FROM rules WHERE match_type = 'text' ORDER BY priority DESC",
      )
      .all<{ pattern: string; category_id: number }>();
    const lower = desc.toLowerCase();
    for (const rule of textRules.results ?? []) {
      if (lower.includes(rule.pattern.toLowerCase())) {
        return { category_id: rule.category_id, display_name: null, is_transfer: false, real_category_id: null, planned_id: null };
      }
    }
  }

  return { category_id: null, display_name: null, is_transfer: false, real_category_id: null, planned_id: null };
}
