// §A1 — the FACT layer: "the metro fare went from 8 to 30 ₴".
//
// A fact is the user's (or the model's) statement about the WORLD, which the canon may then use to
// correct a category's monthly level. It lives in its own file rather than in `advisor.ts` for two
// reasons, and the second one is structural:
//
//  1. it is a plain CRUD unit with no advice logic in it at all;
//  2. `chat-tools.ts` needs `addFact` (the model can file a fact from the conversation), and
//     `advisor.ts` needs the chat tools. Leaving facts where they were would have closed an
//     import cycle between the two — which is why the extraction happened when it did rather than
//     "eventually": the file-size check (C3) refused the growth, and this was the honest way out.
//
// ⚠️ THE GATE: only a CONFIRMED fact with an adjustment moves a number (`applyFactAdjustments` in
// `stats.ts`). Storing one is a proposal, not an edit — a model-authored guess must never silently
// change what the user's runway says.
import type { Env } from "../../env.ts";
import { st, resolveLocale } from "../platform/i18n.ts";
import { catNameSql } from "../finance/categories-i18n.ts";
import type { Fact, FactInput as SharedFactInput } from "../../../shared/api/ai.ts";

/**
 * A stored fact, i.e. the CONTRACT type.
 *
 * `adjust_kind` is narrowed to the two literals rather than `string` even though the column is a
 * plain `TEXT` with no CHECK: every write goes through `FactInput`, which already accepts only
 * those two, so a third value cannot arrive. Declaring it wider here was the sort of imprecision
 * that forced the client to hand-write its own narrower twin — defect D2 in one line.
 */
export type FactRow = Fact;
/** Creation input. `source` is server-side only, which is why this is not `SharedFactInput`. */
export interface FactInput extends SharedFactInput { source?: string }

export async function listFacts(env: Env): Promise<FactRow[]> {
  const loc = await resolveLocale(env);
  const rows = await env.DB.prepare(
    `SELECT f.id, f.text, f.effective_from, f.expires_at, f.category_id,
            ${catNameSql(loc, "c.name")} AS category_name, f.adjust_kind, f.adjust_value,
            f.confirmed_at, f.source, f.created_at
     FROM facts f LEFT JOIN categories c ON c.id = f.category_id
     ORDER BY f.confirmed_at IS NOT NULL, f.created_at DESC`,
  ).all<FactRow>();
  return rows.results ?? [];
}

export async function addFact(env: Env, f: FactInput): Promise<{ id: number | null }> {
  const now = Math.floor(Date.now() / 1000);
  const text = (f.text ?? "").trim();
  if (!text) throw new Error(st(await resolveLocale(env), "factTextRequired"));
  // Коригування числа тільки при заданій категорії.
  const kind = f.category_id != null ? (f.adjust_kind ?? null) : null;
  const value = kind ? (f.adjust_value ?? null) : null;
  // Ручний факт від користувача = він сам ввів число → підтвердження за замовчуванням дозволене.
  const confirmedAt = f.confirm !== false && kind != null ? now : null;
  const res = await env.DB.prepare(
    `INSERT INTO facts (text, effective_from, expires_at, category_id, adjust_kind, adjust_value, confirmed_at, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(
    text, f.effective_from ?? now, f.expires_at ?? null, f.category_id ?? null,
    kind, value, confirmedAt, f.source ?? "user", now,
  ).first<{ id: number }>();
  return { id: res?.id ?? null };
}

// Гейт підтвердження: лише підтверджений факт із коригуванням рухає числа (categoryMonthlyLevels).
export async function confirmFact(env: Env, id: number, on: boolean): Promise<void> {
  await env.DB.prepare("UPDATE facts SET confirmed_at = ? WHERE id = ?")
    .bind(on ? Math.floor(Date.now() / 1000) : null, id).run();
}

export async function deleteFact(env: Env, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM facts WHERE id = ?").bind(id).run();
}

