/**
 * §TX-CHAT — the conversation about ONE operation, and the audit trail it leaves.
 *
 * Split from `advisor.ts` on 2026-08-12 under lint C3, and the seam was already there: everything
 * else in that file builds a picture of the whole financial situation, while this answers a
 * question about a single row and may WRITE to it — the only AI path in the app that edits the
 * user's data from a conversation.
 *
 * That power is why §AI-AUDIT lives here too: a model that can silently move a transaction into
 * another category needs to leave a record of what it moved it from.
 */
import type { Env } from "../../env.ts";
import { st, resolveLocale } from "../platform/i18n.ts";
import { catNameSql } from "../finance/categories-i18n.ts";
import { txChat } from "./tasks.ts";
import type { ChatMsg } from "./ai.ts";
import { logUsage } from "./cost.ts";
import { getProfile } from "./advisor.ts";

/** What the conversation actually changed on the row, echoed back so the UI can say so. */
interface TxChatApplied {
  category_id?: number;
  category_name?: string;
  is_transfer?: boolean;
  understanding?: string;
}

/**
 * §AI-AUDIT — record a field the model rewrote, before it is rewritten.
 *
 * Best-effort and deliberately so: an audit trail that could block the change it describes would
 * make the app worse at the thing the user actually asked for. A missing log line is a gap in
 * history; a failed categorisation is a failed feature.
 */
async function logAiChange(
  env: Env, txId: string, field: "category_id" | "is_transfer" | "ai_note",
  oldValue: string | number | null, newValue: string | number | null, source: string,
): Promise<void> {
  try {
    const repo = await import("../../repo/ai-changes.ts");
    await repo.logChange(env.DB, txId, field, oldValue, newValue, source, Math.floor(Date.now() / 1000));
  } catch (e) {
    console.error("[ai-audit] could not log a change:", e instanceof Error ? e.message : e);
  }
}

export async function chatAboutTx(
  env: Env,
  id: string,
  messages: ChatMsg[],
): Promise<{ reply: string; applied?: TxChatApplied }> {
  const loc = await resolveLocale(env);
  const tx = await env.DB.prepare(
    `SELECT t.id, t.merchant, t.comment, t.mcc, t.amount, t.currency_code, t.category_id,
            t.is_transfer, t.user_note, t.ai_note, ${catNameSql(loc, "c.name")} AS category_name
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?`,
  ).bind(id).first<{
    id: string; merchant: string | null; comment: string | null; mcc: number | null;
    amount: number; currency_code: number; category_id: number | null; is_transfer: number;
    user_note: string | null; ai_note: string | null; category_name: string | null;
  }>();
  if (!tx) return { reply: st(await resolveLocale(env), "errTxNotFound") };

  const tags = await env.DB.prepare(
    `SELECT ${catNameSql(loc, "c.name")} AS name FROM transaction_tags tt JOIN categories c ON c.id = tt.category_id WHERE tt.transaction_id = ?`,
  ).bind(id).all<{ name: string }>();

  const ctx = {
    name: tx.merchant ?? tx.comment ?? "operation",
    bank_comment: tx.comment,
    mcc: tx.mcc,
    amount: Math.round(tx.amount / 100),
    currency_code: tx.currency_code,
    sign: tx.amount < 0 ? "expense" : "income",
    current_category: tx.category_name ?? "uncategorised",
    current_category_id: tx.category_id,
    is_transfer: !!tx.is_transfer,
    tags: (tags.results ?? []).map((t) => t.name),
    user_note: tx.user_note ?? null,
    user_profile: (await getProfile(env)) || null,
  };

  const { result, usage } = await txChat(env, ctx, messages);
  logUsage("tx-chat", usage);

  const applied: TxChatApplied = {};
  // Категорію міняємо, лише якщо AI явно повернув інший валідний id.
  if (result.category_id != null && result.category_id !== tx.category_id) {
    const cat = await env.DB.prepare("SELECT name FROM categories WHERE id = ?")
      .bind(result.category_id).first<{ name: string }>();
    if (cat) {
      await logAiChange(env, id, "category_id", tx.category_id, result.category_id, "chat");
      await env.DB.prepare("UPDATE transactions SET category_id = ? WHERE id = ?").bind(result.category_id, id).run();
      applied.category_id = result.category_id;
      applied.category_name = cat.name;
    }
  }
  if (result.is_transfer !== undefined && !!result.is_transfer !== !!tx.is_transfer) {
    await logAiChange(env, id, "is_transfer", tx.is_transfer ?? 0, result.is_transfer ? 1 : 0, "chat");
    await env.DB.prepare("UPDATE transactions SET is_transfer = ? WHERE id = ?").bind(result.is_transfer ? 1 : 0, id).run();
    applied.is_transfer = !!result.is_transfer;
  }
  // §Хвіст: чат оновлює «AI розуміє це як» (ai_note). txChat повертає уточнене understanding —
  // раніше воно викидалось, тож пояснення в чаті («це моя зарплата з крипти») не приживалось на
  // екрані. Тепер персистимо, щоб рядок відображав актуальне розуміння після розмови.
  const understanding = result.understanding?.trim();
  if (understanding) {
    await logAiChange(env, id, "ai_note", tx.ai_note, understanding, "chat");
    await env.DB.prepare("UPDATE transactions SET ai_note = ? WHERE id = ?").bind(understanding, id).run();
    applied.understanding = understanding;
  }

  return { reply: result.reply, applied: Object.keys(applied).length ? applied : undefined };
}
