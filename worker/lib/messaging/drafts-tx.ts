/**
 * `drafts-tx` — news about ONE OPERATION: an unusually large single charge and a double debit.
 *
 * Split out of `notify.ts` on 2026-09-20 under lint C3, on the seam that file had already drawn
 * for itself with a comment: both drafters here deliberately read raw `t.amount` instead of the
 * canonical `EFF_AMOUNT`/`STATS_JOINS`, because a split divides an operation for CATEGORY
 * analytics while the bank took one amount once — and that amount is what a card about a single
 * charge has to show. Every other drafter in the family speaks about a period, a plan or a
 * budget; these two speak about a row.
 *
 * They keep SEPARATE preferences (`big_tx`, `duplicate`): one is «look at this», the other is
 * «this may be the terminal charging you twice», and muting curiosity is not muting an error.
 */
import type { Env } from "../../env.ts";
import { resolveLocale } from "../platform/i18n.ts";
import { catNameSql } from "../finance/categories-i18n.ts";
import { isRecurringExpr, defaultRefFrom } from "../finance/stats.ts";
import { isVoidedExpr } from "../../repo/transactions.ts";
import type { Draft } from "./notify.ts";

// ⚠️ Гілки нижче свідомо працюють з `t.amount`, а НЕ з канонічним `EFF_AMOUNT`/STATS_JOINS:
// це подієві сигнали про ОДНУ ОПЕРАЦІЮ (великий чек, дубль списання), а не агрегати по
// категоріях. Спліт ділить операцію на частини для КАТЕГОРІЙНОЇ аналітики, але з погляду
// банку це одне списання однією сумою — саме її і треба показати. Фільтри витрати
// повторюють суть `SPEND_WHERE` на рівні рядка (без рол-апу категорій).
// Exported: `draftTodo` back in `notify.ts` counts the same rows («витрати без категорії»), and a
// second spelling of «what counts as one spend row» is exactly the divergence C1 exists to stop.
export const TX_SPEND = "t.amount < 0 AND t.transfer_pair_id IS NULL AND t.is_transfer = 0";

/**
 * Незвично велика ОДНА витрата: ≥3× середнього чека своєї категорії за 90 днів.
 *
 * ⚠️ Регулярне виключаємо канонічним `isRecurringExpr` (підписка/розстрочка за `planned_id`
 * АБО мерчант із витратами в ≥3 різних місяцях). Без цього оренда 12 500 ₴ щомісяця летіла б
 * у стрічку як «велика витрата» — перевірено на реальних даних. Регулярний платіж великий
 * за визначенням і користувач про нього знає; новина — лише НЕсподіваний великий чек.
 */
export async function draftBigTx(env: Env, now: number): Promise<Draft[]> {
  // §LANG-ARCH: the category name is rendered in the feed, so it resolves like every other name
  // that reaches a screen. `catNameSql` was applied to `repo/*` and then to `lib/ai/*`, and
  // `lib/messaging/*` — which writes the feed the reader actually sees — used it NOWHERE: an
  // English reader got «Продукти» in a notification and "Groceries" in the category list.
  const locale = await resolveLocale(env);
  const MIN_ABS = 50000;                      // 500 ₴ — нижче не сигнал, хоч би який множник
  const notRecurring = `NOT ${isRecurringExpr(defaultRefFrom(now), now)}`;
  const rows = await env.DB.prepare(
    `WITH avg_check AS (
       SELECT t.category_id AS cat, AVG(-t.amount) AS avg_amt, COUNT(*) AS n
       FROM transactions t
       WHERE t.time >= ? AND t.time < ? AND ${TX_SPEND}
       GROUP BY t.category_id
     )
     SELECT t.id AS id, t.merchant AS merchant, -t.amount AS amount, t.time AS time,
            ${catNameSql(locale, "c.name")} AS category, a.avg_amt AS avg_amt
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     JOIN avg_check a ON a.cat IS t.category_id
     WHERE t.time >= ? AND ${TX_SPEND} AND a.n >= 5 AND ${notRecurring}
       AND NOT ${isVoidedExpr("t")}
       AND -t.amount >= ? AND -t.amount >= a.avg_amt * 3
     ORDER BY t.amount ASC LIMIT 3`,
  ).bind(now - 90 * 86400, now - 2 * 86400, now - 2 * 86400, MIN_ABS)
    .all<{ id: string; merchant: string | null; amount: number; time: number; category: string | null; avg_amt: number }>();

  return (rows.results ?? []).map((r) => ({
    kind: "big_tx" as const,
    tkey: "big_tx" as const,
    tparams: {
      merchant: r.merchant, amount: r.amount, mult: (r.amount / r.avg_amt).toFixed(1),
      category: r.category, avg: Math.round(r.avg_amt),
    },
    severity: "info" as const,
    entity_type: "tx", entity_id: r.id,
    dedup_key: `big_tx:${r.id}`,
  }));
}

/**
 * Дубль списання: той самий мерчант і та сама сума у вікні доби. Термінал/подвійний тап.
 *
 * ⚠️ BOTH rows must be real spends and NEITHER may already be cancelled (§VOID-PAIR, 2026-09-21).
 * Only the `a` side used to be filtered, so the other leg of a transfer counted as the second
 * charge; and a terminal that charged twice and reversed one of them is precisely the case the
 * card must NOT warn about — the money is back, and a warning about it sends the person to the
 * bank over nothing.
 */
export async function draftDuplicates(env: Env, now: number): Promise<Draft[]> {
  const rows = await env.DB.prepare(
    `SELECT a.id AS id, b.id AS other_id, a.merchant AS merchant, -a.amount AS amount, a.time AS time
     FROM transactions a
     JOIN transactions b ON b.merchant = a.merchant AND b.amount = a.amount AND b.id <> a.id
       AND b.time BETWEEN a.time - 86400 AND a.time + 86400
     WHERE a.time >= ? AND ${TX_SPEND.replace(/t\./g, "a.")}
       AND ${TX_SPEND.replace(/t\./g, "b.")}
       AND NOT ${isVoidedExpr("a")} AND NOT ${isVoidedExpr("b")}
       AND a.merchant IS NOT NULL AND a.merchant <> '' AND -a.amount >= 5000
     ORDER BY a.time DESC LIMIT 20`,
  ).bind(now - 3 * 86400)
    .all<{ id: string; other_id: string; merchant: string; amount: number; time: number }>();

  const seen = new Set<string>();
  const out: Draft[] = [];
  for (const r of rows.results ?? []) {
    // Джойн дає обидва напрямки (A→B і B→A) — ключ із відсортованої пари згортає їх в одне.
    const pair = [r.id, r.other_id].sort().join("~");
    if (seen.has(pair)) continue;
    seen.add(pair);
    out.push({
      kind: "duplicate",
      tkey: "duplicate",
      tparams: { merchant: r.merchant, amount: r.amount },
      severity: "warn",
      entity_type: "tx", entity_id: r.id,
      dedup_key: `duplicate:${pair}`,
    });
    if (out.length >= 3) break;
  }
  return out;
}
