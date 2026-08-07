// `/transactions/*` — the operations feed and everything hanging off a single operation:
// splits, reimbursements, tags, enrichment and the per-transaction chat.
//
// Route order inside this file is behaviour: `/transactions/frequent` MUST stay above
// `/transactions/:id`, or Hono resolves the literal as an id (a real outage, CLAUDE.md).
import { createCashTx } from "../../lib/finance/finance.ts";
import * as accountsRepo from "../../repo/accounts.ts";
import * as categoriesRepo from "../../repo/categories.ts";
import * as txRepo from "../../repo/transactions.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes, normChatMessages } from "./_shared.ts";
import { editTransaction, type TxEdit } from "../../services/transactions.ts";
import { setReimbursement, type ReimbursementBody } from "../../services/reimbursements.ts";

export const transactions = apiRoutes();

// ---- transactions -----------------------------------------------------------

transactions.get("/transactions", async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const category = url.searchParams.get("category");
  const catparent = url.searchParams.get("catparent"); // включає підкатегорії
  const account = url.searchParams.get("account");
  const type = url.searchParams.get("type"); // expense | income
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const q = url.searchParams.get("q");
  const amin = url.searchParams.get("amin"); // мін. сума (₴, порівняння по модулю)
  const amax = url.searchParams.get("amax"); // макс. сума (₴)

  return c.json(await txRepo.listFeed(c.env.DB, c.get("locale"), {
    limit, offset,
    category: category ? Number(category) : undefined,
    catparent: catparent ? Number(catparent) : undefined,
    account: account ?? undefined,
    type: type === "expense" || type === "income" ? type : undefined,
    from: from ? Number(from) : undefined,
    to: to ? Number(to) : undefined,
    q: q ?? undefined,
    // ₴ → копійки тут, бо це розбір ВВОДУ; порівняння по модулю — у репозиторії.
    aminMinor: amin ? Math.round(Number(amin) * 100) : undefined,
    amaxMinor: amax ? Math.round(Number(amax) * 100) : undefined,
  }));
});

// Bulk-редагування виділених транзакцій (мультивибір на /tx): призначити групу,
// категорію чи позначити переказом одразу для набору. Порожній ids — no-op.
transactions.post("/transactions/bulk", async (c) => {
  const b = await c.req.json<{
    ids: string[]; event_id?: number | null; category_id?: number | null; is_transfer?: boolean;
    importance?: string | null; tag_ids?: number[];
  }>();
  const ids = [...new Set(b.ids ?? [])].filter(Boolean);
  if (!ids.length) return c.json({ ok: true, updated: 0 });

  const patch: txRepo.BulkPatch = {};
  if (b.event_id !== undefined) patch.event_id = b.event_id;
  if (b.category_id !== undefined) patch.category_id = b.category_id;
  if (b.is_transfer !== undefined) patch.is_transfer = b.is_transfer;
  // §6 вагомість: null = зняти override операції (успадкує від категорії). Чужі значення
  // не пускаємо — вони мовчки випали б з `EFF_IMPORTANCE` і зіпсували всю аналітику вагомості.
  if (b.importance !== undefined) {
    if (b.importance !== null && !["essential", "discretionary", "optional"].includes(b.importance)) {
      return c.json({ error: "invalid importance" }, 400);
    }
    patch.importance = b.importance;
  }

  // §FK-GUARD: фільтруємо теги по наявних категоріях перед записом — пояснення в
  // `repo/categories.ts existingIds`.
  const want = [...new Set(b.tag_ids ?? [])].filter((t): t is number => Number.isFinite(t));
  const validTags = want.length ? await categoriesRepo.existingIds(c.env.DB, want) : [];
  if (!Object.keys(patch).length && !validTags.length) return c.json({ ok: true, updated: 0 });

  return c.json({ ok: true, updated: await txRepo.bulkApply(c.env.DB, ids, patch, validTags) });
});

// Single transaction with joined names + attached receipt (for the detail page).
// ⚠️ MUST stay above `GET /transactions/:id` — Hono matches in registration order, so a
// literal path declared after the parameterised one is simply never reached ("frequent"
// gets read as an id and answers 404).
/**
 * Cash operations the user repeats, for one-tap re-entry.
 *
 * Only manually entered rows (`source IN ('cash','manual')`) — the point is to save typing the
 * same "кава 45" again, and a bank-imported merchant is not something you re-enter by hand.
 * The suggested amount is the MEDIAN of the last few, not the mean: one atypical 900 ₴ refill
 * would otherwise drag every suggestion off the value the user actually repeats.
 */
transactions.get("/transactions/frequent", async (c) => {
  const rows = await txRepo.frequentManual(c.env.DB, Math.floor(Date.now() / 1000) - 180 * 86400);

  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
  };
  return c.json(rows.map((r) => ({
    merchant: r.merchant,
    category_id: r.category_id,
    currency_code: r.currency_code,
    n: r.n,
    amount: Math.abs(median(r.amounts.split(",").map(Number).filter(Number.isFinite))),
  })));
});

transactions.get("/transactions/:id", async (c) => {
  const id = c.req.param("id");
  const loc = c.get("locale");
  const tx = await txRepo.byId(c.env.DB, loc, id);
  if (!tx) return c.json({ error: "not_found" }, 404);

  let receipt = null;
  const receiptId = (tx as { receipt_id: number | null }).receipt_id;
  if (receiptId) {
    const r = await txRepo.receiptById(c.env.DB, receiptId);
    if (r) receipt = { ...r, items: await txRepo.receiptItems(c.env.DB, receiptId) };
  }
  const tags = await txRepo.tagsFor(c.env.DB, loc, id);
  return c.json({ ...tx, receipt, tags });
});

// Manual / cash entry. For source='cash' we route to the cash account, not a card.
transactions.post("/transactions", async (c) => {
  const b = await c.req.json<{
    account_id?: string; amount: number; currency_code?: number; time?: number;
    merchant?: string; category_id?: number; user_note?: string; source?: string;
  }>();
  try {
    const id = await createCashTx(c.env.DB, b);
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
});

/**
 * Manual transfer between two of the user's own accounts.
 *
 * Written as a PAIR with a shared `transfer_pair_id`, because that is the canonical definition of
 * "one movement between my accounts" (§Інваріанти) — it is the single thing `SPEND_WHERE` looks
 * at to keep the money out of spending, and the only marker the list uses to collapse the two
 * legs into one row. Setting `is_transfer = 1` alone would NOT do it: five separate code paths
 * set that flag and none of them produces a pair, so the movement would show up as an expense
 * plus an unexplained income.
 *
 * Cross-currency is explicit, never guessed: `transactions.currency_code` is the ACCOUNT's
 * currency, so moving ₴ into a $ account needs both numbers. Converting one into the other at
 * today's rate would silently invent an exchange rate the user never got.
 */
transactions.post("/transactions/transfer", async (c) => {
  type TransferBody = {
    from_account_id?: string; to_account_id?: string;
    amount?: number; to_amount?: number; time?: number; user_note?: string;
  };
  const b = await c.req.json<TransferBody>().catch((): TransferBody => ({}));
  const locale = c.get("locale");
  const from = b.from_account_id, to = b.to_account_id;
  const amount = Math.round(Number(b.amount));
  if (!from || !to || from === to) return c.json({ error: st(locale, "errTransferAccounts") }, 400);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: st(locale, "errTransferAmount") }, 400);

  const accs = await accountsRepo.currenciesFor(c.env.DB, [from, to]);
  const byId = new Map(accs.map((a) => [a.id, a]));
  const src = byId.get(from), dst = byId.get(to);
  if (!src || !dst) return c.json({ error: st(locale, "errTransferAccounts") }, 400);

  const toAmount = dst.currency_code === src.currency_code
    ? amount
    : Math.round(Number(b.to_amount));
  if (!Number.isFinite(toAmount) || toAmount <= 0) {
    return c.json({ error: st(locale, "errTransferToAmount") }, 400);
  }

  const pair = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const time = b.time ?? now;
  const note = b.user_note?.trim() || null;
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  await txRepo.insertTransferPair(c.env.DB, [
    { id: ids[0]!, account_id: from, time, amount: -amount, currency_code: src.currency_code },
    { id: ids[1]!, account_id: to, time, amount: toAmount, currency_code: dst.currency_code },
  ], pair, note, now);
  return c.json({ ok: true, pair_id: pair, ids });
});

// Edit + optional "apply to all like this" learning (§6.3). When learn=true and the
// tx came from mono, we store a merchant_alias keyed on the raw mono description.
transactions.patch("/transactions/:id", async (c) => {
  const b = await c.req.json<TxEdit>();
  const r = await editTransaction(c.env.DB, c.req.param("id"), b);
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, learned: r.learned });
});

// ---- AI enrichment (hybrid) -------------------------------------------------

// Enrich one transaction on demand (manual "AI: що це?").
transactions.post("/transactions/:id/enrich", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { enrichOne } = await import("../../lib/ai/enrich.ts");
  try {
    const ok = await enrichOne(c.env, c.req.param("id"), { force: true });
    return c.json(ok ? { ok: true } : { error: "not_found" }, ok ? 200 : 404);
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §SPLIT: спліт транзакції на кілька категорій. GET — частини tx; PUT — замінити всі (порожній
// масив = прибрати спліт). Валідація: лише витрата, ≥2 частини, кожна <0, сума частин = сумі tx.
// Спліт міняє категорійну аналітику → інвалідуємо Tx/Summary/Advice на клієнті.
transactions.get("/transactions/:id/splits", async (c) => {
  return c.json(await txRepo.splitsFor(c.env.DB, c.get("locale"), c.req.param("id")));
});

transactions.put("/transactions/:id/splits", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ splits?: { category_id: number; amount: number }[] }>().catch(() => ({ splits: [] }));
  const splits = (body.splits ?? []).map((p) => ({ category_id: Number(p.category_id), amount: Math.round(Number(p.amount)) }));
  const tx = await txRepo.amountOf(c.env.DB, id);
  if (!tx) return c.json({ error: st(c.get("locale"), "errTxNotFound") }, 404);
  if (splits.length > 0) {
    if (tx.amount >= 0) return c.json({ error: st(c.get("locale"), "errSplitOnlyExpense") }, 400);
    // Дзеркало перевірки в `/reimbursement`: спліт і компенсація взаємовиключні (див. там же).
    const r = await txRepo.reimbursedOf(c.env.DB, id);
    if ((r?.reimbursed ?? 0) > 0) return c.json({ error: st(c.get("locale"), "errSplitHasReimbursement") }, 400);
    if (splits.length < 2) return c.json({ error: st(c.get("locale"), "errSplitMinParts") }, 400);
    if (splits.some((p) => !p.category_id || !Number.isFinite(p.amount) || p.amount >= 0)) {
      return c.json({ error: st(c.get("locale"), "errSplitPartShape") }, 400);
    }
    const sum = splits.reduce((s, p) => s + p.amount, 0);
    if (sum !== tx.amount) return c.json({ error: st(c.get("locale"), "errSplitSumMismatch", { amount: tx.amount }) }, 400);
  }
  await txRepo.replaceSplits(c.env.DB, id, splits, Math.floor(Date.now() / 1000));
  return c.json({ ok: true, count: splits.length });
});

// ---- §COMPENSATION: «мені скинули за це гроші» (міграція 0029) ----------------
// Витрата стає ЧАСТКОВО чужою: у статистику йде лише те, що реально твоє
// (`EFF_AMOUNT = t.amount + t.reimbursed`, stats.ts), а привʼязані надходження перестають
// рахуватись і доходом, і поверненням. Тут лише транспорт + валідація.

// Перерахунок обох денормалізованих сум — `repo/transactions.ts recalcStmts` (ЄДИНЕ місце, де
// вони пишуться; інакше `reimbursed`/`reimburses_total` розійшлися б із `tx_reimbursements`,
// а канон читає саме їх).

// Поточний стан + кандидати. Кандидат — надходження в межах ±21 дня, у якого ЛИШИВСЯ вільний
// залишок: одне надходження може покривати кілька витрат («скинули 2400 — 1870 за одне,
// решта за інше»), тож вичерпаність рахуємо по `reimburses_total`, а не по факту привʼязки.
transactions.get("/transactions/:id/reimbursement", async (c) => {
  const id = c.req.param("id");
  const loc = c.get("locale");
  const tx = await txRepo.reimbursementTarget(c.env.DB, id);
  if (!tx) return c.json({ error: st(loc, "errTxNotFound") }, 404);

  const WINDOW = 21 * 86400;
  const [linked, candidates] = await Promise.all([
    txRepo.reimbursementsLinked(c.env.DB, loc, id),
    txRepo.reimbursementCandidates(c.env.DB, loc, id, tx.currency_code, tx.time, WINDOW),
  ]);

  return c.json({
    tx: { id: tx.id, amount: tx.amount, currency_code: tx.currency_code, reimbursed: tx.reimbursed ?? 0 },
    linked,
    candidates,
  });
});

// Замінити стан цілком. `allocations` — скільки саме взяти з кожного надходження; якщо сума не
// вказана, беремо стільки, скільки треба й скільки є (min(вільний залишок, непокрита частина)).
// `manual_amount` — компенсація без надходження в базі (віддали готівкою). Порожньо = зняти все.
transactions.put("/transactions/:id/reimbursement", async (c) => {
  const body = await c.req.json<ReimbursementBody>().catch((): ReimbursementBody => ({}));
  const r = await setReimbursement(c.env.DB, c.req.param("id"), body);
  // The service names the failure, the route words it: one place decides the rules, another the
  // status code and the language.
  if (!r.ok) {
    const e = r.error;
    return c.json({ error: st(c.get("locale"), e.key, "params" in e ? e.params : undefined) }, e.status);
  }
  return c.json({ ok: true, ...r.result });
});

// Зворотний бік: куди пішло ЦЕ надходження. Потрібно, щоб побачити нерозподілений залишок
// («скинули 2400, використано 1870 — 530 ще вільні») і дійти звідси до інших витрат.
transactions.get("/transactions/:id/reimbursement-usage", async (c) => {
  const id = c.req.param("id");
  const tx = await txRepo.reimbursementSource(c.env.DB, id);
  if (!tx) return c.json({ error: st(c.get("locale"), "errTxNotFound") }, 404);
  if (tx.amount <= 0) return c.json({ used: [], allocated: 0, available: 0 });

  const used = await txRepo.reimbursementUsage(c.env.DB, c.get("locale"), id);

  const allocated = tx.reimburses_total ?? 0;
  return c.json({ used, allocated, available: tx.amount - allocated, currency_code: tx.currency_code });
});

// Інлайн-чат по конкретній операції: обговорити/уточнити з AI; він може оновити
// категорію чи прапорець переказу, коли з розмови стало ясно, що це.
transactions.post("/transactions/:id/chat", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const body = await c.req.json<{ messages?: { role: string; content: string }[] }>();
  const msgs = normChatMessages(body.messages);
  if (!msgs.length) return c.json({ error: "messages required" }, 400);
  const { chatAboutTx } = await import("../../lib/ai/advisor.ts");
  try {
    return c.json(await chatAboutTx(c.env, c.req.param("id"), msgs));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});
