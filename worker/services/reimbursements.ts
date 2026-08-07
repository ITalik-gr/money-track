// §COMPENSATION — "someone paid me back for this" (migration 0029, schema v2 in 0030).
//
// One incoming payment is DISTRIBUTED across several expenses. `tx_reimbursements` is the source
// of truth; `transactions.reimbursed` and `transactions.reimburses_total` are denormalised copies
// that the canon reads (`EFF_AMOUNT`, `EFF_INCOME`, `SPEND_WHERE`, `INCOME_WHERE`). This module is
// the SINGLE writer of both — the whole point of v2 is that the two stay derivable from the
// allocation rows, because in v1 the difference between an over-sized payment and the expense it
// covered fell out of spending AND out of income, and the money simply vanished from the reports.
//
// It returns a named failure rather than a message: the route decides the status code and the
// wording, so an i18n key never has to be threaded through the business rules.
import type { AppDb } from "../lib/platform/db-shim.ts";
import * as txRepo from "../repo/transactions.ts";

/** Every way the scenario can refuse, named after the i18n key the route will look up. */
export type ReimbursementError =
  | { key: "errTxNotFound"; status: 404 }
  | { key: "errReimbOnlyExpense" | "errReimbHasSplit" | "errReimbSomeNotFound" | "errReimbSelf"
      | "errReimbOnlyIncome" | "errReimbCurrency" | "errReimbNegative" | "errReimbTotalNegative"; status: 400 }
  | { key: "errReimbSourceExceeded"; status: 400; params: { left: string; take: string } }
  | { key: "errReimbExceedsExpense"; status: 400; params: { total: string; expense: string } };

export type ReimbursementBody = {
  manual_amount?: number | null;
  allocations?: { source_id: string; amount?: number | null }[];
};

export type ReimbursementResult = { reimbursed: number; allocations: number; manual: number };

/**
 * Replace an expense's compensation state wholesale. `allocations` says how much to take from
 * each incoming payment; with no amount, it takes as much as is needed and as much as is left.
 * `manual_amount` is compensation with no row behind it (handed over in cash). Empty clears all.
 */
export async function setReimbursement(
  db: AppDb,
  id: string,
  body: ReimbursementBody,
): Promise<{ ok: true; result: ReimbursementResult } | { ok: false; error: ReimbursementError }> {
  const fail = (error: ReimbursementError) => ({ ok: false as const, error });
  const wanted = (body.allocations ?? []).filter((a) => a?.source_id);

  const tx = await txRepo.amountAndCurrency(db, id);
  if (!tx) return fail({ key: "errTxNotFound", status: 404 });
  if (tx.amount >= 0) return fail({ key: "errReimbOnlyExpense", status: 400 });
  const expenseTotal = -tx.amount;

  // §SPLIT×§COMPENSATION: свідомо взаємовиключні. Компенсація каже «скільки з цього моє»,
  // спліт — «на що пішло»; накласти одне на одне означало б ділити компенсацію по частинах
  // з округленням, і сума частин перестала б сходитись із сумою операції.
  const hasSplits = await txRepo.hasSplits(db, id);
  if (hasSplits && (wanted.length || body.manual_amount)) return fail({ key: "errReimbHasSplit", status: 400 });

  const rows: { source_id: string; amount: number }[] = [];
  let running = 0;

  if (wanted.length) {
    const ids = [...new Set(wanted.map((a) => String(a.source_id)))];
    // `available` рахуємо БЕЗ урахування того, що вже віддано ЦІЙ витраті: інакше редагування
    // наявного розподілу впиралося б у власний же залишок і зменшити суму було б неможливо.
    const found = await txRepo.sourcesWithAvailable(db, id, ids);
    if (found.length !== ids.length) return fail({ key: "errReimbSomeNotFound", status: 400 });
    const byId = new Map(found.map((r) => [r.id, r]));

    for (const a of wanted) {
      const r = byId.get(String(a.source_id))!;
      if (r.id === id) return fail({ key: "errReimbSelf", status: 400 });
      if (r.amount <= 0) return fail({ key: "errReimbOnlyIncome", status: 400 });
      // Валюти не зводимо: компенсація живе в тій самій валюті, що й витрата (`reimbursed`
      // додається до `t.amount` напряму). Інакше курс мовчки спотворив би суму витрати.
      if (r.currency_code !== tx.currency_code) return fail({ key: "errReimbCurrency", status: 400 });

      // Без явної суми беремо рівно стільки, скільки ще треба і скільки лишилось у джерела.
      const need = Math.max(0, expenseTotal - running);
      const take = a.amount == null ? Math.min(r.available, need) : Math.round(Number(a.amount));
      if (!Number.isFinite(take) || take < 0) return fail({ key: "errReimbNegative", status: 400 });
      if (take === 0) continue;
      if (take > r.available) {
        return fail({
          key: "errReimbSourceExceeded", status: 400,
          params: { left: (r.available / 100).toFixed(2), take: (take / 100).toFixed(2) },
        });
      }
      running += take;
      rows.push({ source_id: r.id, amount: take });
    }
  }

  const manual = body.manual_amount == null ? 0 : Math.round(Number(body.manual_amount));
  if (!Number.isFinite(manual) || manual < 0) return fail({ key: "errReimbTotalNegative", status: 400 });
  const total = running + manual;
  // Стеля — сума самої витрати. Компенсація більша за витрату зробила б `EFF_AMOUNT` додатним,
  // і рядок випав би з аналітики взагалі (ні витрата, ні дохід).
  if (total > expenseTotal) {
    return fail({
      key: "errReimbExceedsExpense", status: 400,
      params: { total: (total / 100).toFixed(2), expense: (expenseTotal / 100).toFixed(2) },
    });
  }

  // Джерела, яких торкаємось: старі (їх треба перерахувати після видалення) + нові.
  const prev = await txRepo.allocationSources(db, id);
  const touched = [...new Set([id, ...prev, ...rows.map((r) => r.source_id)])];

  // Порядок у батчі — ЦЕ і є поведінка: спершу зняти старі розподіли, тоді записати нові, тоді
  // перерахувати денормалізовані суми з таблиці, і лише в кінці добити ручну компенсацію
  // (у неї немає рядка-джерела, тож перерахунок її не побачив би).
  const now = Math.floor(Date.now() / 1000);
  const stmts = [txRepo.clearAllocationsStmt(db, id)];
  for (const r of rows) stmts.push(txRepo.insertAllocationStmt(db, id, r.source_id, r.amount, now));
  stmts.push(...txRepo.recalcStmts(db, touched));
  if (manual > 0) stmts.push(txRepo.addManualReimbursedStmt(db, id, manual));
  await db.batch(stmts);

  return { ok: true, result: { reimbursed: total, allocations: rows.length, manual } };
}
