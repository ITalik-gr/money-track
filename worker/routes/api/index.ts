// Core REST API for the dashboard. All money is minor units; the client divides by 100.
//
// This file owns the request-wide middleware and MOUNTS the domain modules; the handlers
// themselves live in the sibling files. Mount order is behaviour — Hono matches in registration
// order, and `/transactions/frequent` has to be reachable before `/transactions/:id` (a real
// outage, recorded in CLAUDE.md). Each domain keeps its own literals above its own patterns, and
// no two domains share a path prefix, which is what makes the mount order below safe to read.
import { apiRoutes, normImportance, normChatMessages } from "./_shared.ts";
import { analytics } from "./analytics.ts";
import { setState, getState } from "../../lib/finance/repo.ts";
import { computeSummary, createCashTx, getRates } from "../../lib/finance/finance.ts";
// NOTE: no `STATS_JOINS` / `SPEND_WHERE` / `amountSum` here any more — the canonical SQL
// fragments now live behind `worker/repo/`, and a route that needs one is a route that is about
// to grow its own definition of "spending". What is left below is JS-side canon (period bounds,
// levels, projections), which routes are allowed to call.
import {
  valueMode, uahMult, categoryMonthlyLevels, localMonthStart,
  type PeriodMode,
} from "../../lib/finance/stats.ts";
import type { AppDb } from "../../lib/platform/db-shim.ts";
import * as accountsRepo from "../../repo/accounts.ts";
import * as categoriesRepo from "../../repo/categories.ts";
import * as txRepo from "../../repo/transactions.ts";
import * as goalsRepo from "../../repo/goals.ts";
import * as planningRepo from "../../repo/planning.ts";
import * as budgetsRepo from "../../repo/budgets.ts";
import * as eventsRepo from "../../repo/events.ts";
import * as reportsRepo from "../../repo/reports.ts";
import * as knowledgeRepo from "../../repo/knowledge.ts";
import * as stateRepo from "../../repo/state.ts";
// `catNameSql` is deliberately absent: it produces SQL, and the route layer no longer writes any.
import { localizeCatName, ownerLocale } from "../../lib/finance/categories-i18n.ts";
import { recalcGoal, isGoalKind, isAutofillKind } from "../../lib/finance/goals.ts";
import { st } from "../../lib/platform/i18n.ts";
import type { NotifLocale } from "../../../shared/notif-i18n.ts";

export const api = apiRoutes();

// Resolve the owner's UI locale once per request (P3.4). Category display names are stored in
// Ukrainian; when the owner runs the app in English they are translated SERVER-SIDE via
// `catNameSql`/`localizeCatName`, so the client stays unchanged. `uk` sessions pay nothing —
// `catNameSql` is a no-op for them. Read here (not per-handler) to avoid repeating the lookup.
//
// It sits ABOVE the mounts on purpose: parent middleware runs for a mounted sub-app too, so this
// is the one place the lookup happens for all of them.
api.use("*", async (c, next) => {
  c.set("locale", await ownerLocale(c.env.DB));
  await next();
});

// ---- domain modules ---------------------------------------------------------

api.route("/", analytics);

// ---- reference data ---------------------------------------------------------

api.get("/categories", async (c) => {
  const rows = await categoriesRepo.listAll(c.env.DB);
  const loc = c.get("locale");
  // Localize seed names in JS (the row already carries `name`); user categories pass through.
  return c.json(rows.map((r) => ({ ...r, name: localizeCatName(loc, r.name) })));
});

api.get("/accounts", async (c) => {
  return c.json(await accountsRepo.listActive(c.env.DB));
});

// Канонічна розбивка коштів (§R3) — ТА САМА, що бачить Порадник. Огляд на сторінці Рахунків
// бере її, а не рахує композицію на клієнті, щоб «подушка/борг/інвестиції» тут = у Пораднику.
api.get("/accounts/funds", async (c) => {
  const { fundsBreakdown } = await import("../../lib/ai/advisor.ts");
  return c.json(await fundsBreakdown(c.env));
});

// Архівовані рахунки (is_active=0) — для секції «Архів». Історія операцій лишається.
api.get("/accounts/archived", async (c) => {
  return c.json(await accountsRepo.listArchived(c.env.DB));
});

// Історія балансу ручних рахунків по місяцях — для міні-спарклайнів на картках. Значення у
// ВАЛЮТІ рахунку (для тренду валюта не важлива); крок = останній зріз ≤ кінець місяця (carry-forward).
api.get("/accounts/history", async (c) => {
  const url = new URL(c.req.url);
  const months = Math.min(24, Math.max(3, Number(url.searchParams.get("months") ?? 6)));
  const rows = await accountsRepo.balanceHistory(c.env.DB);
  if (rows === null) return c.json({ history: {} }); // таблиця може ще не бути на remote (0026)
  const byAcc = new Map<string, { at: number; balance: number }[]>();
  for (const r of rows) (byAcc.get(r.acc) ?? byAcc.set(r.acc, []).get(r.acc)!).push({ at: r.at, balance: r.balance });
  const now = Math.floor(Date.now() / 1000);
  const ends: number[] = [];
  for (let i = months - 1; i >= 0; i--) {
    // кінець i-го місяця назад; для поточного (i=0) — «зараз», бо кінець місяця ще попереду.
    ends.push(i === 0 ? now : localMonthStart(now, -i + 1) - 1);
  }
  const out: Record<string, number[]> = {};
  for (const [acc, hist] of byAcc) {
    if (!hist.length) continue;
    out[acc] = ends.map((t) => {
      let v = hist[0].balance;
      for (const p of hist) { if (p.at <= t) v = p.balance; else break; }
      return Math.round(v / 100);
    });
  }
  return c.json({ history: out });
});

// ---- net-worth summary (§5 credit-limit handling) ---------------------------

api.get("/summary", async (c) => {
  return c.json(await computeSummary(c.env));
});

// ---- transactions -----------------------------------------------------------

api.get("/transactions", async (c) => {
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

// L10 — повний дамп власних даних одним файлом.
//
// Причина існування: дані живуть в ОДНОМУ Durable Object і бекапів немає (усвідомлена межа,
// записана в §Де і як лежать дані). CSV-експорт віддає лише операції — без категорій, рахунків,
// планів, бюджетів, цілей, чеків і сповіщень. Тобто найгірший сценарій («обʼєкт зник») не був
// закритий узагалі. Кнопка «вивантажити все» коштує майже нічого і закриває його.
//
// **Таблиці читаються з `sqlite_master`, а не зі списку в коді.** Бекап, який мовчки не бере
// таблицю з наступної міграції, гірший за відсутність бекапу: він виглядає як бекап. Тому
// сюди автоматично потрапляє все, що не в денилисті нижче.
const EXPORT_SKIP = new Set([
  // Шифротекст ключів. Майстер-ключ — Worker-секрет, тож у файлі це мертвий вантаж, який усе
  // одно не розшифрувати; класти його у файл, що йде на диск користувача, — зайва поверхня.
  "user_secrets",
]);

api.get("/export/all.json", async (c) => {
  const tables = await stateRepo.exportableTables(c.env.DB);

  // Порожній список означає, що схему не вдалося прочитати — а не що даних нема. Віддати за
  // цієї умови «успішний» файл на кілька байт було б найгіршим із можливих результатів: людина
  // вважала б, що бекап у неї є.
  if (!tables.length) return c.json({ error: "export_schema_unreadable" }, 500);

  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const name of tables) {
    if (EXPORT_SKIP.has(name)) continue;
    data[name] = await stateRepo.dumpTable(c.env.DB, name);
    counts[name] = data[name].length;
  }

  const body = JSON.stringify({
    meta: {
      app: "money-track",
      format: 1,
      exported_at: Math.floor(Date.now() / 1000),
      schema_version: await stateRepo.schemaVersion(c.env.DB),
      // Кількості поруч із даними — щоб урізаний або побитий файл було видно без парсингу всього.
      rows: counts,
      note: "Full dump of this account's Durable Object. Encrypted API keys (user_secrets) are excluded.",
    },
    data,
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="money-track-${day}.json"`,
      "cache-control": "no-store",
    },
  });
});

// §J: CSV-експорт транзакцій (для бухгалтера/податкової). Опційні from/to (unix). BOM для
// коректної кирилиці в Excel; сума — у валюті рахунку. Пара-переказ — один рядок (як у списку).
const CUR_ALPHA: Record<number, string> = { 980: "UAH", 840: "USD", 978: "EUR", 985: "PLN", 826: "GBP", 756: "CHF" };
api.get("/export/transactions.csv", async (c) => {
  const url = new URL(c.req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const rows = await txRepo.forCsvExport(
    c.env.DB, c.get("locale"), from ? Number(from) : null, to ? Number(to) : null);
  // ---- CSV dialect (B2) ----------------------------------------------------
  // The RFC-4180 file we used to emit (`,` + decimal point) opens as ONE column in Excel on a
  // Ukrainian/European locale, which reads as "the export is broken" — and even after splitting
  // it by hand the amount column will not sum, because `-1234.56` is text where the decimal mark
  // is a comma. Neither failure is loud; the file just looks wrong.
  //
  // So the default is the dialect that opens correctly on a double-click here: `sep=;` (Excel
  // honours it, Sheets accepts it), `;` between fields, `,` as the decimal mark. `?dialect=rfc`
  // keeps the strict form for a script or a US-locale sheet, because guessing wrong there is the
  // same silent breakage in the other direction.
  const rfc = url.searchParams.get("dialect") === "rfc";
  const sep = rfc ? "," : ";";
  const num = (n: number) => (rfc ? n.toFixed(2) : n.toFixed(2).replace(".", ","));
  // Whether a cell is "a plain number" depends on the decimal mark in use — see the exemption
  // below. Getting this wrong is not cosmetic: every negative amount would be quoted into text
  // and the amount column would stop summing, which is precisely the bug being fixed.
  const numeric = rfc ? /^-?\d+(\.\d+)?$/ : /^-?\d+(,\d+)?$/;
  // Quoting must follow the ACTIVE separator, not a hardcoded comma: with `;` fields, a value
  // containing `;` is what needs quoting, and a value containing `,` no longer does.
  const needsQuote = new RegExp(`["${sep === ";" ? ";" : ","}\\n\\r]`);

  const esc = (v: unknown) => {
    let s = v == null ? "" : String(v);
    // CSV formula injection (fixed 2026-07-26, security review). Excel/Sheets execute a cell that
    // starts with = + - @ or a leading tab/CR, and one of these columns is the bank COMMENT —
    // text a stranger types when sending a P2P transfer. So an attacker picks the payload, the
    // victim opens their own export, and the spreadsheet runs it. A leading apostrophe makes the
    // cell literal text; it is the standard defence and costs one character in the file.
    // A plain number is exempt — otherwise every negative amount would be quoted into text and
    // the Сума column would stop summing, which is the whole reason to export a CSV.
    if (/^[=+\-@\t\r]/.test(s) && !numeric.test(s)) s = `'${s}`;
    return needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const loc = c.get("locale");
  const header = [
    st(loc, "csvDate"), st(loc, "csvMerchant"), st(loc, "csvComment"), st(loc, "csvNote"),
    st(loc, "csvAmount"), st(loc, "csvCurrency"), st(loc, "csvCategory"), st(loc, "csvAccount"),
    st(loc, "csvGroup"), st(loc, "csvTransfer"),
  ];
  const lines = [header.map(esc).join(sep)];
  for (const r of rows) {
    lines.push([
      new Date(r.time * 1000).toISOString().slice(0, 10),
      r.merchant ?? "", r.comment ?? "", r.user_note ?? "",
      num(r.amount / 100), CUR_ALPHA[r.currency_code] ?? String(r.currency_code),
      r.category_name ?? "", r.account_title ?? "", r.event_name ?? "",
      r.is_transfer ? st(loc, "csvYes") : "",
    ].map(esc).join(sep));
  }
  // BOM keeps Cyrillic readable in Excel; the `sep=` hint must come AFTER it and before the
  // header, which is the only position Excel recognises.
  const csv = "﻿" + (rfc ? "" : `sep=${sep}\r\n`) + lines.join("\r\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="money-track-transactions.csv"`,
    },
  });
});

// Bulk-редагування виділених транзакцій (мультивибір на /tx): призначити групу,
// категорію чи позначити переказом одразу для набору. Порожній ids — no-op.
api.post("/transactions/bulk", async (c) => {
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
api.get("/transactions/frequent", async (c) => {
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

api.get("/transactions/:id", async (c) => {
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
api.post("/transactions", async (c) => {
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
api.post("/transactions/transfer", async (c) => {
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
api.patch("/transactions/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<{
    category_id?: number | null; merchant?: string; user_note?: string; learn?: boolean;
    is_transfer?: boolean; tags?: number[]; event_id?: number | null; real_category_id?: number | null;
    importance?: string | null; lock_name?: boolean;
  }>();

  const tx = await txRepo.rawById(c.env.DB, id) as {
    source: string; raw_json: string | null; comment: string | null; mcc: number | null; merchant: string | null;
  } | null;
  if (!tx) return c.json({ error: "not_found" }, 404);

  // §R7: ручна назва авторитетна. Ставимо name_locked=1, коли користувач змінив назву на
  // непорожню й іншу; явний lock_name (кнопка «дозволити AI змінювати») може зняти/поставити.
  const renamed = b.merchant !== undefined && !!b.merchant?.trim() && b.merchant.trim() !== (tx.merchant ?? "").trim();

  // Теги (вторинні категорії, до 3, без основної) — повна заміна набору.
  if (b.tags !== undefined) {
    await txRepo.clearTags(c.env.DB, id);
    const tags = [...new Set(b.tags)].filter((t) => t !== b.category_id).slice(0, 3);
    for (const t of tags) await txRepo.addTag(c.env.DB, id, t);
  }

  const patch: txRepo.TxPatch = {};
  if (b.category_id !== undefined) patch.category_id = b.category_id;
  if (b.merchant !== undefined) patch.merchant = b.merchant;
  if (b.user_note !== undefined) patch.user_note = b.user_note;
  if (b.is_transfer !== undefined) patch.is_transfer = b.is_transfer;
  if (b.real_category_id !== undefined) patch.real_category_id = b.real_category_id;
  if (b.event_id !== undefined) patch.event_id = b.event_id;
  if (b.importance !== undefined) patch.importance = normImportance(b.importance);
  if (b.lock_name !== undefined) patch.name_locked = b.lock_name;
  else if (renamed) patch.name_locked = true;
  await txRepo.updateFields(c.env.DB, id, patch);

  // §R2-TX4: «реальна категорія» має сенс лише для бакета «Перекази і зняття».
  // Для звичайних операцій прибираємо її, щоб не дублювала основну й не плутала.
  await txRepo.clearRealCategoryOutsideTransfers(c.env.DB, id);

  let learned = false;
  if (b.learn) {
    const raw = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }) : null;
    const rawKey = raw?.description?.trim();
    if (rawKey) {
      const transferFlag = b.is_transfer ? 1 : 0;
      // Реальну категорію переказу зберігаємо в alias; якщо цього разу її не передали —
      // не губимо раніше навчену (беремо з наявного alias).
      const prior = await txRepo.aliasRealCategory(c.env.DB, rawKey);
      const realCat = b.real_category_id !== undefined ? b.real_category_id : (prior?.real_category_id ?? null);
      // Idempotent: one alias per raw description — a re-edit replaces the old rule.
      // §Хвіст: source='manual' — ця правка захищена, enrich/консенсус її не перетруть.
      await txRepo.deleteAlias(c.env.DB, rawKey);
      await txRepo.insertManualAlias(c.env.DB, rawKey, b.merchant ?? null, b.category_id ?? null,
        transferFlag, realCat, Math.floor(Date.now() / 1000));
      // Back-apply to existing matching mono transactions (name, category, transfer flag, real category).
      await txRepo.backApplyAlias(c.env.DB, b.category_id ?? null, b.merchant ?? null, transferFlag, realCat, rawKey);
      learned = true;
    }
  }
  return c.json({ ok: true, learned });
});

// ---- budgets & planned ------------------------------------------------------

api.get("/budgets", async (c) => {
  return c.json(await budgetsRepo.listAll(c.env.DB));
});

// Idempotent set: one budget per category+period. amount<=0 clears it.
api.put("/budgets", async (c) => {
  const b = await c.req.json<{ category_id: number; period: "month" | "week"; amount: number; rollover?: boolean }>();
  if (b.amount > 0) {
    await budgetsRepo.set(c.env.DB, b.category_id, b.period, b.amount, !!b.rollover);
  } else {
    await budgetsRepo.clear(c.env.DB, b.category_id, b.period);
  }
  return c.json({ ok: true });
});

/**
 * Автобюджет із історії — детерміновано, БЕЗ AI (є окремий `/budgets/chat` для розмови).
 *
 * Ліміт = канонічний місячний рівень категорії (`categoryMonthlyLevels`, §Канонічне) мінус
 * запас `trim`%. Беремо саме рівень, а не «середнє за 90 днів»: він уже вміє відрізняти
 * fixed-кост від змінної категорії й не роздувається разовим піком.
 *
 * ⚠️ Обовʼязкові категорії (`importance='essential'` — оренда, продукти, ліки) НЕ ріжемо:
 * запропонувати «оренду на 10% менше» неможливо виконати, і такий бюджет одразу стає
 * фальшивим червоним. Їм ліміт = рівень як є.
 * GET віддає ПРОПОЗИЦІЮ (нічого не змінює), POST застосовує обрані — щоб один тап не
 * переписав мовчки вже налаштовані конверти.
 */
api.get("/budgets/auto", async (c) => {
  const url = new URL(c.req.url);
  const trim = Math.min(Math.max(Number(url.searchParams.get("trim") ?? 10), 0), 50) / 100;
  const rates = await getRates(c.env.DB);
  const { mult } = valueMode(rates, null);
  const now = Math.floor(Date.now() / 1000);

  const [levels, cats, currentByCat] = await Promise.all([
    categoryMonthlyLevels(c.env, mult, { now }),
    categoriesRepo.budgetable(c.env.DB, c.get("locale")),
    budgetsRepo.monthlyAmounts(c.env.DB),
  ]);

  const MIN_LEVEL = 30000; // 300 ₴/міс — дрібним категоріям конверт не потрібен
  const items = cats
    .map((cat) => {
      const level = levels.get(cat.id)?.level ?? 0;
      if (level < MIN_LEVEL) return null;
      const essential = cat.importance === "essential";
      // Округлюємо до 50 ₴ — «2 350 ₴» читається як рішення, «2 347 ₴» як шум обчислення.
      const raw = essential ? level : level * (1 - trim);
      const suggested = Math.max(MIN_LEVEL, Math.round(raw / 5000) * 5000);
      return {
        category_id: cat.id, name: cat.name, color: cat.color,
        importance: cat.importance ?? "discretionary",
        essential,
        level, suggested,
        current: currentByCat.get(cat.id) ?? null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.level - a.level);

  return c.json({
    trim_pct: Math.round(trim * 100),
    total_level: items.reduce((s, i) => s + i.level, 0),
    total_suggested: items.reduce((s, i) => s + i.suggested, 0),
    items,
  });
});

api.post("/budgets/auto", async (c) => {
  const b = await c.req.json<{ items?: { category_id: number; amount: number }[] }>()
    .catch(() => ({} as { items?: { category_id: number; amount: number }[] }));
  const items = (b.items ?? [])
    .map((i) => ({ category_id: Number(i.category_id), amount: Math.round(Number(i.amount)) }))
    .filter((i) => Number.isFinite(i.category_id) && i.amount > 0);
  if (!items.length) return c.json({ error: st(c.get("locale"), "errNothingToApply") }, 400);

  await budgetsRepo.setMonthlyBatch(c.env.DB, items);
  return c.json({ ok: true, applied: items.length });
});

// §Хвіст C: глобальний лічильник витрат AI — «$ за сьогодні / цей місяць / за весь час».
api.get("/ai-usage", async (c) => {
  const { readUsageStats } = await import("../../lib/ai/ai.ts");
  return c.json(await readUsageStats(c.env));
});

// §Хвіст: факт vs план по підписках — фактичні списання, лічильник, ознака подорожчання.
api.get("/planned/actuals", async (c) => {
  const { plannedActuals } = await import("../../lib/finance/subscriptions.ts");
  return c.json(await plannedActuals(c.env.DB));
});

// §Аналітика 2.0 — AI-репорти (щотижня/щомісяця, історія зберігається).
api.get("/reports", async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 24), 60);
  return c.json(await reportsRepo.list(c.env.DB, url.searchParams.get("type"), limit));
});

api.get("/reports/:id", async (c) => {
  const row = await reportsRepo.find(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const { data_json, ...meta } = row;
  return c.json({ ...meta, data: JSON.parse(data_json) });
});

// Видалити репорт (напр. тестові генерації). Ідемпотентно — 404 не критично.
api.delete("/reports/:id", async (c) => {
  await reportsRepo.remove(c.env.DB, c.req.param("id"));
  return c.json({ ok: true });
});

// Згенерувати репорт на вимогу (кнопка).
//   type=week|month + scope=last (завершений період, як у крона) | current (поточний до сьогодні);
//   type=custom + from/to (unix, секунди) — довільний діапазон, обраний користувачем.
// force перегенеровує наявний репорт того самого періоду.
//
// ⚠️ `scope` за замовчуванням був `current`, і це й був баг: кнопка «за тиждень» завжди рахувала
// ПОТОЧНИЙ тиждень до сьогодні, тож у понеділок вранці вона давала майже порожній звіт, а
// завершений тиждень вручну не генерувався взагалі. Тепер дефолт — `last`, як у крона.
api.post("/reports/generate", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const body = await c.req.json<{ type?: string; force?: boolean; scope?: string; from?: number; to?: number }>()
    .catch(() => ({} as { type?: string; force?: boolean; scope?: string; from?: number; to?: number }));
  const locale = c.get("locale");

  const { generateAndStoreReport, CUSTOM_MIN_DAYS, CUSTOM_MAX_DAYS } = await import("../../lib/ai/report.ts");

  // Кастомний діапазон розпізнаємо і за явним type, і за самою присутністю меж — клієнт, що
  // прислав from/to, точно не хоче пресетний тиждень.
  const wantsCustom = body.type === "custom" || (Number.isFinite(body.from) && Number.isFinite(body.to));
  let range: { from: number; to: number } | undefined;
  if (wantsCustom) {
    const from = Math.floor(Number(body.from));
    const to = Math.floor(Number(body.to));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return c.json({ error: st(locale, "reportBadRange") }, 400);
    }
    const days = (to - from) / 86400;
    if (days < CUSTOM_MIN_DAYS || days > CUSTOM_MAX_DAYS) {
      return c.json({ error: st(locale, "reportRangeLimits", { min: CUSTOM_MIN_DAYS, max: CUSTOM_MAX_DAYS }) }, 400);
    }
    range = { from, to };
  }

  const t = wantsCustom ? "custom" as const : body.type === "month" ? "month" as const : "week" as const;
  try {
    const res = await generateAndStoreReport(c.env, t, {
      force: body.force ?? true,
      scope: body.scope === "current" ? "current" : "last",
      range,
    });
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

// ---- §A6: фонові AI-генерації -----------------------------------------------
//
// Клієнт ставить задачу й одразу отримує id — робота йде на alarm об'єкта, тож піти зі
// сторінки (і навіть закрити вкладку) її не скасовує. Поллінг лише поки щось активне.

api.post("/jobs", async (c) => {
  const locale = c.get("locale");
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(locale, "errAiKeyMissing"), code: "no_ai_key" }, 400);

  const body = await c.req.json<{ kind?: string; params?: unknown }>().catch(() => ({} as { kind?: string; params?: unknown }));
  const { JOB_KINDS, enqueueJob, runNextJob } = await import("../../lib/ai/jobs.ts");
  const kind = JOB_KINDS.find((k) => k === body.kind);
  if (!kind) return c.json({ error: st(locale, "jobBadKind") }, 400);

  const { id, created } = await enqueueJob(c.env, kind, body.params);

  const { isDemoEnv } = await import("../../lib/platform/demo.ts");
  if (isDemoEnv(c.env)) {
    // Демо рахує синхронно: `demoClamp` тисне вивід до 900 токенів, тож чекати там і так
    // недовго, а єдиний alarm пісочниці зайнятий її самознищенням. Клієнт цього не помічає —
    // він у будь-якому разі бачить задачу через `GET /jobs`, просто вже завершеною.
    if (created) await runNextJob(c.env);
  } else {
    await c.env.scheduleWork?.();
  }
  return c.json({ job_id: id, created });
});

api.get("/jobs", async (c) => {
  const { listJobs } = await import("../../lib/ai/jobs.ts");
  return c.json({ items: await listJobs(c.env) });
});

// Клієнт підтверджує, що показав тост. Без цього «завершені й не показані» показувались би
// щоразу при вході — або губились би зовсім у того, хто закрив вкладку.
api.post("/jobs/:id/seen", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const { markSeen } = await import("../../lib/ai/jobs.ts");
  await markSeen(c.env, id);
  return c.json({ ok: true });
});

api.get("/planned", async (c) => {
  return c.json(await planningRepo.listActive(c.env.DB));
});

api.post("/planned", async (c) => {
  const b = await c.req.json<{
    title: string; kind: "subscription" | "installment"; total_amount?: number;
    period_amount?: number; period: "month" | "week"; period_count?: number; start_date: number;
    category_id?: number; account_id?: string; currency_code?: number;
  }>();
  const periodCount = Math.max(1, Math.round(b.period_count ?? 1)); // «кожні N періодів» (§SUB4)
  // Installment auto-math (§6.5): derive occurrences/end_date from total & per-period.
  let occurrences: number | null = null;
  let end_date: number | null = null;
  if (b.kind === "installment" && b.total_amount && b.period_amount) {
    occurrences = Math.ceil(b.total_amount / b.period_amount);
    const step = (b.period === "week" ? 7 * 86400 : 30 * 86400) * periodCount;
    end_date = b.start_date + occurrences * step;
  }
  const id = await planningRepo.create(c.env.DB, {
    title: b.title, kind: b.kind,
    total_amount: b.total_amount ?? null, period_amount: b.period_amount ?? null,
    period: b.period, period_count: periodCount, start_date: b.start_date,
    end_date, occurrences,
    category_id: b.category_id ?? null, account_id: b.account_id ?? null,
    currency_code: b.currency_code ?? 980,
  });
  return c.json({ ok: true, id, occurrences, end_date });
});

// AI-детект підписки за описом (§F4): користувач описує словами → AI дістає пошуковий
// запит; шукаємо схожі транзакції, рахуємо середню суму/валюту/каденцію → кандидат.
api.post("/planned/ai-detect", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { description } = await c.req.json<{ description?: string }>();
  if (!description?.trim()) return c.json({ error: "description required" }, 400);

  const { callHaikuJson, MODEL_SMART } = await import("../../lib/ai/ai.ts");
  let query = "";
  try {
    // Sonnet 5 — точніше витягує ключове слово мерчанта з вільного опису підписки.
    const { result } = await callHaikuJson<{ merchant_query: string }>(
      c.env,
      [{ type: "text", text: "Користувач описує рекурентний платіж (підписку). Витягни коротке ключове слово для пошуку мерчанта в транзакціях (латиницею або як у виписці, напр. «моя підписка на Anthropic»→«Anthropic», «інтернет Київстар»→«Київстар»). Відповідай ВИКЛЮЧНО JSON {\"merchant_query\": \"...\"}." }],
      [{ type: "text", text: description.slice(0, 300) }],
      120,
      MODEL_SMART,
    );
    query = (result.merchant_query ?? "").trim();
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
  if (!query) return c.json({ candidates: [] });

  // Схожі витрати за ~200 днів згруповані по мерчанту+валюті (без переказів/холдів).
  const since = Math.floor(Date.now() / 1000) - 200 * 86400;
  const matches = await planningRepo.merchantMatches(c.env.DB, query, since);

  const candidates = matches.map((r) => ({
    title: r.merchant,
    period_amount: Math.round(r.avg_amount),
    currency_code: r.currency_code,
    n: r.n,
    last_time: r.last_time,
    category_id: r.category_id,
    avg_interval_days: r.n > 1 ? Math.round((r.last_time - r.first_time) / (r.n - 1) / 86400) : 30,
  }));
  return c.json({ query, candidates });
});

api.delete("/planned/:id", async (c) => {
  await planningRepo.deactivate(c.env.DB, Number(c.req.param("id")));
  return c.json({ ok: true });
});

// §R5: редагувати підписку (наразі — опис для AI; розширювано за потреби).
api.patch("/planned/:id", async (c) => {
  const b = await c.req.json<{ note?: string | null; category_id?: number | null }>();
  await planningRepo.update(c.env.DB, Number(c.req.param("id")), {
    ...(b.note !== undefined ? { note: b.note?.trim() || null } : {}),
    ...(b.category_id !== undefined ? { category_id: b.category_id } : {}),
  });
  return c.json({ ok: true });
});

// §R5: закрити кандидата в підписки («це не підписка») — детект більше не пропонує.
api.post("/planned/dismiss", async (c) => {
  const { merchant } = await c.req.json<{ merchant?: string }>();
  if (!merchant?.trim()) return c.json({ error: "merchant required" }, 400);
  await planningRepo.dismissMerchant(c.env.DB, merchant.trim(), Math.floor(Date.now() / 1000));
  return c.json({ ok: true });
});

// Ре-світ: виправити категорію наявних операцій, що підпадають під активну підписку,
// але зараз розкладені інакше (fix для вже неправильних, як Apple $1 у «Розвагах»). Без AI.
api.post("/planned/apply-categories", async (c) => {
  const { applySubscriptionCategories } = await import("../../lib/finance/subscriptions.ts");
  const r = await applySubscriptionCategories(c.env.DB);
  return c.json(r);
});

// Detect recurring payments (§7 "детект підписок"): same merchant+amount charged in
// ≥2 distinct months over the last ~120 days, on a roughly monthly cadence. Heuristic,
// no AI. Excludes merchants already declared as active planned payments.
api.get("/planned/detect", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const since = now - 200 * 86400; // ширше вікно — щоб зловити квартальні/рідші підписки
  // §G2: ВИКЛЮЧАЄМО перекази (is_transfer) і бакет «Перекази і зняття» (13 + діти) —
  // інакше в кандидати лізуть «Округлення балансу», перекази брату/людям тощо.
  // §G3: пропонуємо суджену категорію (найчастіша серед матчів) для звʼязку з підпискою.
  const rows = await planningRepo.detectCandidates(c.env.DB, since);
  const declaredSet = await planningRepo.declaredTitles(c.env.DB);
  // §R5: виключаємо закриті користувачем кандидати («це не підписка»).
  const dismissedSet = await planningRepo.dismissedMerchants(c.env.DB);

  const candidates = rows
    .map((r) => ({
      ...r,
      avg_interval_days: r.n > 1 ? Math.round((r.last_time - r.first_time) / (r.n - 1) / 86400) : 0,
    }))
    // Каденція від ~тижня до ~кварталу (виключає щоденні однакові покупки, напр. каву).
    .filter((r) => r.avg_interval_days >= 6 && r.avg_interval_days <= 100)
    .filter((r) => !declaredSet.has(r.merchant.toLowerCase()))
    .filter((r) => !dismissedSet.has(r.merchant.toLowerCase()));

  return c.json(candidates);
});

// ---- events / groups (івент / проєкт / спец-день) ---------------------------

// Список подій із агрегатами (скільки транзакцій і сума витрат по кожній).
api.get("/events", async (c) => {
  // Рахуємо ВСІ операції групи (вкл. holds — тест/мono-холди мають лічитись).
  // ⚠️ Раніше тут стояв фільтр `currency_code = 980`, тобто валютні витрати групи просто
  // НЕ рахувались. Для подорожі це найгірше можливе місце для такої дірки — саме там
  // валюта і трапляється, і бюджет поїздки виглядав би виконаним. Зводимо в ₴ як усюди.
  const rates = await getRates(c.env.DB);
  return c.json(await eventsRepo.listWithTotals(c.env.DB, uahMult(rates)));
});

// Бюджет події («скільки закладаю на цю подорож»). amount<=0 або null — прибрати ліміт.
api.patch("/events/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ budget?: number | null; name?: string; note?: string | null }>()
    .catch(() => ({} as { budget?: number | null; name?: string; note?: string | null }));
  await eventsRepo.update(c.env.DB, id, {
    ...(b.budget !== undefined
      ? { budget: b.budget == null || b.budget <= 0 ? null : Math.round(b.budget) } : {}),
    // A blank name is IGNORED rather than rejected: this endpoint is also how the budget alone
    // is set, and failing the whole patch over an empty field the caller did not mean to send
    // would block that.
    ...(b.name !== undefined && b.name.trim() ? { name: b.name.trim() } : {}),
    ...(b.note !== undefined ? { note: b.note?.trim() || null } : {}),
  });
  return c.json({ ok: true });
});

api.post("/events", async (c) => {
  const b = await c.req.json<{ name: string; kind?: string; color?: string; icon?: string; note?: string }>();
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = await eventsRepo.create(c.env.DB, {
    name: b.name.trim(), kind: b.kind ?? "event",
    color: b.color ?? null, icon: b.icon ?? null, note: b.note ?? null,
    created_at: Math.floor(Date.now() / 1000),
  });
  return c.json({ ok: true, id });
});

api.delete("/events/:id", async (c) => {
  const id = Number(c.req.param("id"));
  // Order matters and the spending outlives the event: the transactions are unlinked first, and
  // only the GROUP is archived. Deleting a trip must never delete what was spent on it.
  await eventsRepo.unlinkTransactions(c.env.DB, id);
  await eventsRepo.archive(c.env.DB, id);
  return c.json({ ok: true });
});

// Деталь події: підсумок + список транзакцій.
api.get("/events/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const event = await eventsRepo.find(c.env.DB, id);
  if (!event) return c.json({ error: "not_found" }, 404);
  // Підсумки рахує СЕРВЕР і зводить у ₴. Раніше сторінка рахувала їх сама, фільтруючи
  // `currency_code === 980`, тож валютні операції випадали — і та сама група показувала
  // на сторінці меншу суму, ніж у списку. Одна цифра має бути одна.
  const rates = await getRates(c.env.DB);
  const loc = c.get("locale");
  const [txs, agg, plannedItems] = await Promise.all([
    eventsRepo.transactions(c.env.DB, loc, id),
    eventsRepo.totals(c.env.DB, uahMult(rates), id),
    eventsRepo.plannedItems(c.env.DB, loc, id),
  ]);
  return c.json({
    event, transactions: txs,
    spent: agg?.spent ?? 0, income: agg?.income ?? 0,
    planned: plannedItems,
    planned_total: plannedItems.reduce((s, p) => s + p.amount, 0),
  });
});

// Plan line items CRUD (P2.3). Amounts arrive in ₴ minor units.
api.post("/events/:id/planned", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ label?: string; amount?: number; category_id?: number | null }>()
    .catch(() => ({} as { label?: string; amount?: number; category_id?: number | null }));
  if (!b.label?.trim() || !b.amount || b.amount <= 0) return c.json({ error: "label and positive amount required" }, 400);
  const catId = typeof b.category_id === "number" ? b.category_id : null;
  const newId = await eventsRepo.addPlannedItem(
    c.env.DB, id, b.label.trim(), Math.round(b.amount), catId, Math.floor(Date.now() / 1000));
  return c.json({ ok: true, id: newId });
});

api.delete("/events/:id/planned/:pid", async (c) => {
  await eventsRepo.deletePlannedItem(
    c.env.DB, Number(c.req.param("id")), Number(c.req.param("pid")));
  return c.json({ ok: true });
});

// ---- savings goals (§7) -----------------------------------------------------

// Список цілей із прогресом. Якщо привʼязано банку (account_id) — прогрес = її баланс,
// інакше — ручний current_amount.
api.get("/goals", async (c) => {
  const goals = (await goalsRepo.listActive(c.env.DB)).map((g) => ({
    ...g,
    current: g.account_id != null && g.account_balance != null ? g.account_balance : g.current_amount,
  }));
  return c.json(goals);
});

/**
 * §P2.1 — правило авто-поповнення з тіла запиту (міграція 0037).
 *
 * Валідуємо ОБИДВА поля разом: `autofill_kind` без осмисленого значення = мовчазне «нічого
 * не нараховується», а це найгірший стан для фічі, суть якої «воно саме». `null` (вимкнути)
 * лишається легальним, тож `undefined` (не чіпати) і `null` тут різні речі.
 */
function parseAutofill(kind: unknown, value: unknown, locale: NotifLocale): { kind: string | null; value: number | null } | { error: string } {
  if (kind == null) return { kind: null, value: null };
  if (!isAutofillKind(kind)) return { error: st(locale, "goalAutofillKind") };
  const v = Math.round(Number(value));
  if (!Number.isFinite(v) || v <= 0) return { error: st(locale, "goalAutofillValue") };
  // Відсоток — саме відсоток: 150% доходу не «агресивна ціль», а помилка вводу.
  if (kind === "income_pct" && v > 100) return { error: st(locale, "goalAutofillPct") };
  return { kind, value: v };
}

api.post("/goals", async (c) => {
  const b = await c.req.json<{ name: string; target_amount: number; current_amount?: number; account_id?: string | null; deadline?: number | null; color?: string; note?: string; kind?: string; autofill_kind?: string | null; autofill_value?: number | null }>();
  const locale = c.get("locale");
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  if (!(b.target_amount > 0)) return c.json({ error: "target required" }, 400);
  if (b.kind !== undefined && !isGoalKind(b.kind)) return c.json({ error: st(locale, "goalKind") }, 400);
  const auto = parseAutofill(b.autofill_kind ?? null, b.autofill_value, locale);
  if ("error" in auto) return c.json({ error: auto.error }, 400);
  const id = await goalsRepo.create(c.env.DB, {
    name: b.name.trim(),
    target_amount: b.target_amount,
    current_amount: b.current_amount ?? 0,
    account_id: b.account_id ?? null,
    deadline: b.deadline ?? null,
    color: b.color ?? "#2e6be6",
    note: b.note ?? null,
    kind: b.kind ?? "save_up",
    autofill_kind: auto.kind,
    autofill_value: auto.value,
    created_at: Math.floor(Date.now() / 1000),
  });
  return c.json({ ok: true, id });
});

api.patch("/goals/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const locale = c.get("locale");
  const b = await c.req.json<{ name?: string; target_amount?: number; current_amount?: number; account_id?: string | null; deadline?: number | null; color?: string; note?: string; kind?: string; autofill_kind?: string | null; autofill_value?: number | null }>();
  if (b.name !== undefined && !b.name.trim()) return c.json({ error: "name required" }, 400);
  if (b.kind !== undefined && !isGoalKind(b.kind)) return c.json({ error: st(locale, "goalKind") }, 400);

  const patch: goalsRepo.GoalPatch = {
    name: b.name !== undefined ? b.name.trim() : undefined,
    target_amount: b.target_amount, current_amount: b.current_amount,
    account_id: b.account_id, deadline: b.deadline,
    color: b.color, note: b.note, kind: b.kind,
  };
  if (b.autofill_kind !== undefined) {
    const auto = parseAutofill(b.autofill_kind, b.autofill_value, locale);
    if ("error" in auto) return c.json({ error: auto.error }, 400);
    patch.autofill = auto;
  }
  await goalsRepo.update(c.env.DB, id, patch);
  return c.json({ ok: true });
});

api.delete("/goals/:id", async (c) => {
  await goalsRepo.archive(c.env.DB, Number(c.req.param("id")));
  return c.json({ ok: true });
});

// ---- §P2.1: внески в ціль ---------------------------------------------------
//
// `current_amount` — денормалізований SUM внесків; його ЄДИНИЙ писар — `recalcGoal`
// (`lib/finance/goals.ts`). Переїхав у lib, щойно зʼявився другий охочий писати цю суму —
// крон авто-поповнення. Те саме правило, що для §COMPENSATION.
//
// ⚠️ Ціль, привʼязану до БАНКИ (`account_id`), внески не чіпають: там джерело правди —
// баланс рахунку, який веде банк. Дозволити ще й ручні внески означало б рахувати ті самі
// гроші двічі.

api.get("/goals/:id/contributions", async (c) => {
  return c.json(await goalsRepo.listContributions(c.env.DB, Number(c.req.param("id"))));
});

api.post("/goals/:id/contributions", async (c) => {
  const id = Number(c.req.param("id"));
  const locale = c.get("locale");
  const b = await c.req.json<{ amount?: number; at?: number; note?: string | null }>()
    .catch(() => ({} as { amount?: number; at?: number; note?: string | null }));
  const amount = Math.round(Number(b.amount));
  // Нуль забороняємо окремо від NaN: «0» проходить `Number.isFinite`, але внесок на нуль —
  // це рядок в історії, який нічого не означає.
  if (!Number.isFinite(amount) || amount === 0) return c.json({ error: st(locale, "goalContribAmount") }, 400);

  const goal = await goalsRepo.findActive(c.env.DB, id);
  if (!goal) return c.json({ error: st(locale, "goalNotFound") }, 404);
  if (goal.account_id) return c.json({ error: st(locale, "goalJarNoContrib") }, 400);

  await goalsRepo.addContribution(c.env.DB, id, amount,
    Math.floor(b.at ?? Date.now() / 1000), b.note?.trim() || null);
  return c.json({ ok: true, current: await recalcGoal(c.env.DB, id) });
});

api.delete("/goals/:id/contributions/:cid", async (c) => {
  const id = Number(c.req.param("id"));
  await goalsRepo.deleteContribution(c.env.DB, id, Number(c.req.param("cid")));
  return c.json({ ok: true, current: await recalcGoal(c.env.DB, id) });
});

// ---- custom categories ------------------------------------------------------

api.post("/categories", async (c) => {
  const b = await c.req.json<{ name: string; color?: string; icon?: string; parent_id?: number | null; is_income?: boolean; importance?: string | null }>();
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = await categoriesRepo.create(c.env.DB, {
    name: b.name.trim(),
    color: b.color ?? "#6B7A74",
    icon: b.icon ?? "dots",
    parent_id: b.parent_id ?? null,
    is_income: !!b.is_income,
    importance: normImportance(b.importance),
  });
  return c.json({ ok: true, id });
});

// Редагувати будь-яку категорію (зокрема вбудовану): назва/колір/іконка/батько.
// Колонки вже є (міграція 0005), нової міграції не треба. parent_id=null → верхній рівень.
api.patch("/categories/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ name?: string; color?: string; icon?: string; parent_id?: number | null; importance?: string | null }>();
  if (!(await categoriesRepo.exists(c.env.DB, id))) return c.json({ error: "not_found" }, 404);
  if (b.name !== undefined && !b.name.trim()) return c.json({ error: "name required" }, 400);

  await categoriesRepo.update(c.env.DB, id, {
    ...(b.name !== undefined ? { name: b.name.trim() } : {}),
    ...(b.color !== undefined ? { color: b.color } : {}),
    ...(b.icon !== undefined ? { icon: b.icon } : {}),
    ...(b.importance !== undefined ? { importance: normImportance(b.importance) } : {}),
    ...(b.parent_id !== undefined ? { parent_id: b.parent_id } : {}),
  });
  return c.json({ ok: true });
});

// Видалити можна лише кастомну категорію; транзакції знеприв'язуються.
// Скільки всього прив'язано до категорії (для діалогу «куди перенести перед видаленням»).
api.get("/categories/:id/usage", async (c) => {
  return c.json(await categoriesRepo.usage(c.env.DB, Number(c.req.param("id"))));
});

// Видалити категорію, перенісши всі прив'язки на іншу (reassign) або знявши їх (null).
// Захищена лише категорія «Перекази і зняття» (13) — на ній тримається логіка бакета.
api.delete("/categories/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (id === 13) return c.json({ error: st(c.get("locale"), "errTransferCatLocked") }, 400);
  if (!(await categoriesRepo.exists(c.env.DB, id))) return c.json({ error: "not_found" }, 404);

  const raw = new URL(c.req.url).searchParams.get("reassign");
  const target = raw && raw !== "none" && Number(raw) !== id ? Number(raw) : null;

  try {
    // ORDER IS THE BEHAVIOUR: every table referencing the category is dealt with first, and the
    // row itself goes last — the schema enforces those foreign keys, so a step moved after the
    // delete fails. Each call is one table; what "no target" means differs per table and is
    // documented at each function.
    const db = c.env.DB;
    await categoriesRepo.reassignTransactions(db, id, target);
    await categoriesRepo.reassignTags(db, id, target);
    await categoriesRepo.reassignAliases(db, id, target);
    await categoriesRepo.reassignReceiptItems(db, id, target);
    await categoriesRepo.reassignRules(db, id, target);
    await categoriesRepo.reassignPlanned(db, id, target);
    await categoriesRepo.reassignBudgets(db, id, target);
    await categoriesRepo.reassignChildren(db, id, target);
    await categoriesRepo.remove(db, id);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

// Режим періоду (календарний ⇄ ковзний) — єдине джерело для Головної/Статистики/AI.
api.get("/settings/period-mode", async (c) => {
  const mode = ((await getState(c.env.DB, "period_mode")) as PeriodMode) || "calendar";
  return c.json({ mode });
});
api.put("/settings/period-mode", async (c) => {
  const { mode } = await c.req.json<{ mode: PeriodMode }>();
  await setState(c.env.DB, "period_mode", mode === "rolling" ? "rolling" : "calendar");
  return c.json({ ok: true, mode });
});

// UI locale (PLATFORM.md §12). Stored per-user in app_state so it is durable across devices
// and readable server-side (AI/notify locale, P3.4). The client renders from localStorage for
// instant paint; this endpoint is the durable mirror, not the render source. Empty = unset,
// the client then falls back to the browser language.
api.get("/settings/locale", async (c) => {
  const locale = (await getState(c.env.DB, "locale")) || "";
  return c.json({ locale });
});
api.put("/settings/locale", async (c) => {
  const { locale } = await c.req.json<{ locale: string }>();
  const v = locale === "uk" ? "uk" : locale === "en" ? "en" : null;
  if (!v) return c.json({ error: "invalid locale" }, 400);
  await setState(c.env.DB, "locale", v);
  return c.json({ ok: true, locale: v });
});

// AI-моделі ОКРЕМО НА ЗАДАЧУ (report/advisor/insight/…): токен haiku|sonnet|opus на кожну.
// UI редагує три головні (report/advisor/insight); решта — дефолти. Enrich/OCR завжди Haiku.
const AI_MODEL_TASKS = ["report", "advisor", "insight", "chat", "budget", "group", "notify"] as const;
api.get("/settings/ai-models", async (c) => {
  const { AI_TASK_DEFAULTS, TOKEN_BY_MODEL, MODEL_BY_TOKEN } = await import("../../lib/ai/ai.ts");
  const out: Record<string, string> = {};
  for (const t of AI_MODEL_TASKS) {
    const saved = await getState(c.env.DB, `ai_model_${t}`);
    out[t] = saved && MODEL_BY_TOKEN[saved] ? saved : TOKEN_BY_MODEL[AI_TASK_DEFAULTS[t]];
  }
  return c.json({ models: out });
});
api.put("/settings/ai-models", async (c) => {
  const { MODEL_BY_TOKEN } = await import("../../lib/ai/ai.ts");
  const { task, model } = await c.req.json<{ task: string; model: string }>();
  if (!AI_MODEL_TASKS.includes(task as typeof AI_MODEL_TASKS[number]) || !MODEL_BY_TOKEN[model]) {
    return c.json({ error: "invalid task or model" }, 400);
  }
  await setState(c.env.DB, `ai_model_${task}`, model);
  return c.json({ ok: true, task, model });
});

// §4 Прийдешні планові списання (підписки/розстрочки) у горизонті N днів — для віджета
// «скоро спишеться» на Головній. Перетинає межу місяця (на відміну від forecast).
api.get("/planned/upcoming", async (c) => {
  const url = new URL(c.req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30), 1), 90);
  const now = Math.floor(Date.now() / 1000);
  const horizon = now + days * 86400;

  const { nextChargeUnix, plannedUAH } = await import("../../lib/finance/subscriptions.ts");
  const rates = await getRates(c.env.DB);
  const planned = await planningRepo.activeWithCategory(c.env.DB);

  // §CUR-PLAN: `amount` лишається у ВАЛЮТІ ПЛАНУ (щоб показати «$5», а не «≈208 ₴»),
  // `amount_uah` — зведення для підсумків. Раніше валюта губилась і $5 ставало 5 ₴.
  const items = planned
    .filter((p) => !(p.kind === "installment" && p.end_date != null && p.end_date <= now))
    .map((p) => ({
      id: p.id, title: p.title,
      amount: p.period_amount ?? 0,
      currency_code: p.currency_code ?? 980,
      amount_uah: plannedUAH(p.period_amount, p.currency_code, rates),
      at: nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, now),
      days_until: 0,
    }))
    .filter((p) => p.amount > 0 && p.at <= horizon)
    .map((p) => ({ ...p, days_until: Math.max(0, Math.round((p.at - now) / 86400)) }))
    .sort((a, b) => a.at - b.at);

  return c.json({ days, total: items.reduce((s, p) => s + p.amount_uah, 0), items });
});

// ---- AI enrichment (hybrid) -------------------------------------------------

// Enrich one transaction on demand (manual "AI: що це?").
api.post("/transactions/:id/enrich", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { enrichOne } = await import("../../lib/ai/enrich.ts");
  try {
    const ok = await enrichOne(c.env, c.req.param("id"), { force: true });
    return c.json(ok ? { ok: true } : { error: "not_found" }, ok ? 200 : 404);
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// Bulk-enrich uncategorised transactions, a small batch per call (client loops).
api.post("/enrich/pending", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { enrichPending } = await import("../../lib/ai/enrich.ts");
  try {
    return c.json(await enrichPending(c.env));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

api.get("/enrich/status", async (c) => {
  return c.json({ pending: await txRepo.pendingEnrichCount(c.env.DB) });
});

// Detect internal transfers between own accounts (opposite equal amounts, ±15 min).
api.post("/transfers/detect", async (c) => {
  const { detectTransfers } = await import("../../lib/finance/transfers.ts");
  const marked = await detectTransfers(c.env);
  return c.json({ ok: true, marked });
});

// §F2 крок 2: AI-розмітка реальної категорії для операцій у бакеті «Перекази і зняття».
// Малий батч за виклик, клієнт повторює поки remaining > 0. Навчене застосовується без AI.
api.post("/transfers/categorize", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { categorizeTransfers } = await import("../../lib/ai/enrich.ts");
  try {
    return c.json(await categorizeTransfers(c.env));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// Скільки переказів/знять ще без реальної категорії (для стану кнопки).
api.get("/transfers/status", async (c) => {
  const { transfersPending } = await import("../../lib/ai/enrich.ts");
  return c.json({ pending: await transfersPending(c.env) });
});

// §R2-ST4: рев'ю. Проганяє AI по батчу нерозмічених переказів і повертає пропозиції
// (зі збереженням у БД) для перегляду/правки. needs_attention = AI не впевнений/не визначив.
api.post("/transfers/review", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { reviewTransfers } = await import("../../lib/ai/enrich.ts");
  const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? 12);
  try {
    return c.json(await reviewTransfers(c.env, limit));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §C2: перепрогнати ОДИН переказ через AI з підказкою користувача («описати для AI»).
api.post("/transfers/review/one", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const b = await c.req.json<{ id?: string; hint?: string }>();
  if (!b.id || !b.hint?.trim()) return c.json({ error: "id and hint required" }, 400);
  const { reviewTransferWithHint } = await import("../../lib/ai/enrich.ts");
  try {
    const row = await reviewTransferWithHint(c.env, b.id, b.hint);
    return row ? c.json(row) : c.json({ error: "not_found" }, 404);
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §R2-ST4: зберегти правки рев'ю — масово оновити real_category_id по рядках.
// Кожен рядок може навчати alias (щоб схожі перекази авто-розмічались надалі).
api.post("/transfers/review/save", async (c) => {
  const b = await c.req.json<{ items: { id: string; real_category_id: number | null; learn?: boolean }[] }>();
  const now = Math.floor(Date.now() / 1000);
  for (const it of b.items ?? []) {
    await txRepo.setRealCategory(c.env.DB, it.id, it.real_category_id);
    if (it.learn) {
      const tx = await txRepo.sourceAndRaw(c.env.DB, it.id);
      const rawKey = tx?.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }).description?.trim() : null;
      if (tx?.source === "mono" && rawKey) {
        // Прив'язуємо реальну категорію до alias по сирому опису + застосовуємо до схожих.
        const changed = await txRepo.updateAliasRealCategory(c.env.DB, rawKey, it.real_category_id);
        if (!changed) await txRepo.insertAliasRealCategory(c.env.DB, rawKey, it.real_category_id, now);
        await txRepo.backfillRealCategory(c.env.DB, it.real_category_id, rawKey);
      }
    }
  }
  return c.json({ ok: true, saved: (b.items ?? []).length });
});

// ---- weekly AI insight (§6.6) -----------------------------------------------

api.get("/insight", async (c) => {
  const { getStoredInsight } = await import("../../lib/ai/insight.ts");
  return c.json(await getStoredInsight(c.env));
});

// Manual trigger (cron also runs it). ?days= sets and persists the coverage window.
api.post("/insight/generate", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const days = Number(new URL(c.req.url).searchParams.get("days")) || undefined;
  const { buildAndStoreInsight } = await import("../../lib/ai/insight.ts");
  try {
    return c.json(await buildAndStoreInsight(c.env, days));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// ---- AI advisor: financial profile + structured advice ----------------------

api.get("/profile", async (c) => {
  const { getProfile } = await import("../../lib/ai/advisor.ts");
  return c.json({ text: await getProfile(c.env) });
});

api.put("/profile", async (c) => {
  const { text } = await c.req.json<{ text?: string }>();
  const { setProfile } = await import("../../lib/ai/advisor.ts");
  await setProfile(c.env, (text ?? "").slice(0, 4000));
  return c.json({ ok: true });
});

api.get("/advisor", async (c) => {
  const { getStoredAdvice } = await import("../../lib/ai/advisor.ts");
  return c.json(await getStoredAdvice(c.env));
});

api.get("/advisor/history", async (c) => {
  const { getAdviceHistory } = await import("../../lib/ai/advisor.ts");
  return c.json(await getAdviceHistory(c.env));
});

api.delete("/advisor/history", async (c) => {
  const { clearAdviceHistory } = await import("../../lib/ai/advisor.ts");
  await clearAdviceHistory(c.env);
  return c.json({ ok: true });
});

// Порада. Якщо AI недоступний (нема ключа / ліміт / збій моделі) — НЕ віддаємо порожнечу
// й не ховаємось за 502: рахуємо детермінований fallback із канонічних чисел і кажемо, чому
// він тут (`fallback_reason`). Краще деградувати, ніж мовчати (§Обробка помилок).
api.post("/advisor/generate", async (c) => {
  const { buildAdvice, fallbackAdvice } = await import("../../lib/ai/advisor.ts");
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json(await fallbackAdvice(c.env, st(c.get("locale"), "errAiKeyMissing")));
  }
  try {
    return c.json(await buildAdvice(c.env));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[advisor] AI failed, falling back to deterministic advice:", msg);
    try {
      return c.json(await fallbackAdvice(c.env, msg));
    } catch {
      return c.json({ error: msg }, 502);   // впав і fallback — тоді вже чесна помилка
    }
  }
});

// Чат-порадник: діалог по фінансах (клієнт тримає історію, шлемо останні ходи).
api.post("/advisor/chat", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const body = await c.req.json<{ messages?: { role: string; content: string }[]; attachedTxIds?: string[] }>();
  const msgs = normChatMessages(body.messages);
  if (!msgs.length) return c.json({ error: "messages required" }, 400);
  const attached = Array.isArray(body.attachedTxIds) ? body.attachedTxIds.filter((x) => typeof x === "string").slice(0, 10) : [];
  const { chatReply } = await import("../../lib/ai/advisor.ts");
  try {
    return c.json(await chatReply(c.env, msgs, attached));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §A1: шар фактів про світ. Список / додати (ручний) / підтвердити-скасувати / видалити.
// Гейт: лише confirmed факт із коригуванням рухає числа (categoryMonthlyLevels).
api.get("/facts", async (c) => {
  const { listFacts } = await import("../../lib/ai/advisor.ts");
  return c.json(await listFacts(c.env));
});

// §SPLIT: спліт транзакції на кілька категорій. GET — частини tx; PUT — замінити всі (порожній
// масив = прибрати спліт). Валідація: лише витрата, ≥2 частини, кожна <0, сума частин = сумі tx.
// Спліт міняє категорійну аналітику → інвалідуємо Tx/Summary/Advice на клієнті.
api.get("/transactions/:id/splits", async (c) => {
  return c.json(await txRepo.splitsFor(c.env.DB, c.get("locale"), c.req.param("id")));
});

api.put("/transactions/:id/splits", async (c) => {
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
api.get("/transactions/:id/reimbursement", async (c) => {
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
api.put("/transactions/:id/reimbursement", async (c) => {
  const id = c.req.param("id");
  type RbBody = { manual_amount?: number | null; allocations?: { source_id: string; amount?: number | null }[] };
  const body = await c.req.json<RbBody>().catch((): RbBody => ({}));
  const wanted = (body.allocations ?? []).filter((a) => a?.source_id);

  const tx = await txRepo.amountAndCurrency(c.env.DB, id);
  if (!tx) return c.json({ error: st(c.get("locale"), "errTxNotFound") }, 404);
  if (tx.amount >= 0) return c.json({ error: st(c.get("locale"), "errReimbOnlyExpense") }, 400);
  const expenseTotal = -tx.amount;

  // §SPLIT×§COMPENSATION: свідомо взаємовиключні. Компенсація каже «скільки з цього моє»,
  // спліт — «на що пішло»; накласти одне на одне означало б ділити компенсацію по частинах
  // з округленням, і сума частин перестала б сходитись із сумою операції.
  const hasSplits = await txRepo.hasSplits(c.env.DB, id);
  if (hasSplits && (wanted.length || body.manual_amount)) {
    return c.json({ error: st(c.get("locale"), "errReimbHasSplit") }, 400);
  }

  const rows: { source_id: string; amount: number }[] = [];
  let running = 0;

  if (wanted.length) {
    const ids = [...new Set(wanted.map((a) => String(a.source_id)))];
    // `available` рахуємо БЕЗ урахування того, що вже віддано ЦІЙ витраті: інакше редагування
    // наявного розподілу впиралося б у власний же залишок і зменшити суму було б неможливо.
    const found = await txRepo.sourcesWithAvailable(c.env.DB, id, ids);
    if (found.length !== ids.length) return c.json({ error: st(c.get("locale"), "errReimbSomeNotFound") }, 400);
    const byId = new Map(found.map((r) => [r.id, r]));

    for (const a of wanted) {
      const r = byId.get(String(a.source_id))!;
      if (r.id === id) return c.json({ error: st(c.get("locale"), "errReimbSelf") }, 400);
      if (r.amount <= 0) return c.json({ error: st(c.get("locale"), "errReimbOnlyIncome") }, 400);
      // Валюти не зводимо: компенсація живе в тій самій валюті, що й витрата (`reimbursed`
      // додається до `t.amount` напряму). Інакше курс мовчки спотворив би суму витрати.
      if (r.currency_code !== tx.currency_code) return c.json({ error: st(c.get("locale"), "errReimbCurrency") }, 400);

      // Без явної суми беремо рівно стільки, скільки ще треба і скільки лишилось у джерела.
      const need = Math.max(0, expenseTotal - running);
      const take = a.amount == null ? Math.min(r.available, need) : Math.round(Number(a.amount));
      if (!Number.isFinite(take) || take < 0) return c.json({ error: st(c.get("locale"), "errReimbNegative") }, 400);
      if (take === 0) continue;
      if (take > r.available) {
        return c.json({ error: st(c.get("locale"), "errReimbSourceExceeded", { left: (r.available / 100).toFixed(2), take: (take / 100).toFixed(2) }) }, 400);
      }
      running += take;
      rows.push({ source_id: r.id, amount: take });
    }
  }

  const manual = body.manual_amount == null ? 0 : Math.round(Number(body.manual_amount));
  if (!Number.isFinite(manual) || manual < 0) return c.json({ error: st(c.get("locale"), "errReimbTotalNegative") }, 400);
  const total = running + manual;
  // Стеля — сума самої витрати. Компенсація більша за витрату зробила б `EFF_AMOUNT` додатним,
  // і рядок випав би з аналітики взагалі (ні витрата, ні дохід).
  if (total > expenseTotal) {
    return c.json({ error: st(c.get("locale"), "errReimbExceedsExpense", { total: (total / 100).toFixed(2), expense: (expenseTotal / 100).toFixed(2) }) }, 400);
  }

  // Джерела, яких торкаємось: старі (їх треба перерахувати після видалення) + нові.
  const prev = await txRepo.allocationSources(c.env.DB, id);
  const touched = [...new Set([id, ...prev, ...rows.map((r) => r.source_id)])];

  // Порядок у батчі — ЦЕ і є поведінка: спершу зняти старі розподіли, тоді записати нові, тоді
  // перерахувати денормалізовані суми з таблиці, і лише в кінці добити ручну компенсацію
  // (у неї немає рядка-джерела, тож перерахунок її не побачив би).
  const now = Math.floor(Date.now() / 1000);
  const stmts = [txRepo.clearAllocationsStmt(c.env.DB, id)];
  for (const r of rows) stmts.push(txRepo.insertAllocationStmt(c.env.DB, id, r.source_id, r.amount, now));
  stmts.push(...txRepo.recalcStmts(c.env.DB, touched));
  if (manual > 0) stmts.push(txRepo.addManualReimbursedStmt(c.env.DB, id, manual));
  await c.env.DB.batch(stmts);

  return c.json({ ok: true, reimbursed: total, allocations: rows.length, manual });
});

// Зворотний бік: куди пішло ЦЕ надходження. Потрібно, щоб побачити нерозподілений залишок
// («скинули 2400, використано 1870 — 530 ще вільні») і дійти звідси до інших витрат.
api.get("/transactions/:id/reimbursement-usage", async (c) => {
  const id = c.req.param("id");
  const tx = await txRepo.reimbursementSource(c.env.DB, id);
  if (!tx) return c.json({ error: st(c.get("locale"), "errTxNotFound") }, 404);
  if (tx.amount <= 0) return c.json({ used: [], allocated: 0, available: 0 });

  const used = await txRepo.reimbursementUsage(c.env.DB, c.get("locale"), id);

  const allocated = tx.reimburses_total ?? 0;
  return c.json({ used, allocated, available: tx.amount - allocated, currency_code: tx.currency_code });
});

// ---- Центр сповіщень (ROADMAP §Черга 2, v1 in-app) ---------------------------
// Стрічка того, що система «хоче сказати». Уся логіка — `lib/notify.ts` (ЄДИНЕ джерело),
// тут лише транспорт. Генерація йде добовим кроном; `/notifications/generate` — ручний прогін.
api.get("/notifications", async (c) => {
  const url = new URL(c.req.url);
  const { listNotifications } = await import("../../lib/messaging/notify.ts");
  return c.json(await listNotifications(c.env, {
    limit: Number(url.searchParams.get("limit") ?? 60),
    kind: url.searchParams.get("kind"),
    unreadOnly: url.searchParams.get("unread") === "1",
  }));
});

api.post("/notifications/read", async (c) => {
  const body = await c.req.json<{ ids?: number[] }>().catch(() => ({ ids: [] }));
  const ids = (body.ids ?? []).map(Number).filter(Number.isFinite);
  const { markRead, unreadCount } = await import("../../lib/messaging/notify.ts");
  await markRead(c.env, ids);
  return c.json({ ok: true, unread: await unreadCount(c.env) });
});

api.post("/notifications/read-all", async (c) => {
  const { markAllRead } = await import("../../lib/messaging/notify.ts");
  await markAllRead(c.env);
  return c.json({ ok: true, unread: 0 });
});

api.delete("/notifications", async (c) => {
  const { clearNotifications } = await import("../../lib/messaging/notify.ts");
  await clearNotifications(c.env);
  return c.json({ ok: true });
});

api.post("/notifications/generate", async (c) => {
  const { generateNotifications } = await import("../../lib/messaging/notify.ts");
  return c.json(await generateNotifications(c.env));
});

api.get("/notifications/prefs", async (c) => {
  const { getPrefs } = await import("../../lib/messaging/notify.ts");
  return c.json(await getPrefs(c.env));
});

api.put("/notifications/prefs", async (c) => {
  const body = await c.req.json<Record<string, boolean>>().catch(() => ({}));
  const { setPrefs } = await import("../../lib/messaging/notify.ts");
  return c.json(await setPrefs(c.env, body));
});

/**
 * Збережені фільтри Транзакцій («Робочі витрати», «Готівка цього місяця»).
 *
 * Зберігаємо САМ QUERY-РЯДОК, а не розібрані поля: фільтри й так живуть в URL (єдине
 * джерело стану сторінки), тож збережений набір — це просто той самий URL. Нове поле
 * фільтра почне зберігатись автоматично, без міграції й без правок тут.
 * Ліміт 24 — це особистий список швидкого доступу, а не сховище.
 */
const FILTERS_KEY = "saved_filters";
interface SavedFilter { id: string; name: string; query: string }

async function readFilters(db: AppDb): Promise<SavedFilter[]> {
  const raw = await getState(db, FILTERS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SavedFilter[];
    return Array.isArray(parsed) ? parsed.filter((f) => f?.id && f?.name) : [];
  } catch { return []; }
}

api.get("/settings/saved-filters", async (c) => c.json(await readFilters(c.env.DB)));

api.post("/settings/saved-filters", async (c) => {
  const b = await c.req.json<{ name?: string; query?: string }>().catch(() => ({} as { name?: string; query?: string }));
  const name = (b.name ?? "").trim().slice(0, 60);
  const query = (b.query ?? "").replace(/^\?/, "").slice(0, 500);
  if (!name) return c.json({ error: st(c.get("locale"), "errFilterNameRequired") }, 400);
  if (!query) return c.json({ error: st(c.get("locale"), "errFilterNoActive") }, 400);

  const list = await readFilters(c.env.DB);
  if (list.length >= 24) return c.json({ error: st(c.get("locale"), "errFilterTooMany", { max: 24 }) }, 400);
  // Та сама назва — перезапис, а не дубль: інакше список швидко заростає «Робочі (2)».
  const idx = list.findIndex((f) => f.name.toLowerCase() === name.toLowerCase());
  const item: SavedFilter = { id: idx >= 0 ? list[idx].id : crypto.randomUUID(), name, query };
  if (idx >= 0) list[idx] = item; else list.push(item);
  await setState(c.env.DB, FILTERS_KEY, JSON.stringify(list));
  return c.json(list);
});

api.delete("/settings/saved-filters/:id", async (c) => {
  const list = (await readFilters(c.env.DB)).filter((f) => f.id !== c.req.param("id"));
  await setState(c.env.DB, FILTERS_KEY, JSON.stringify(list));
  return c.json(list);
});

/**
 * Глобальний пошук для командної панелі (Ctrl-K): мерчанти, категорії, конкретні операції.
 * Сторінки й дії — статичні, їх фільтрує клієнт (нема сенсу ганяти по мережі).
 *
 * Свідомо ДЕШЕВИЙ: короткі LIMIT-и й префіксний LIKE — панель смикає це на кожен ввід.
 * Мерчанти зводимо агрегатом (сума/кількість), щоб рядок одразу щось означав, а не був
 * просто назвою: «Сільпо · 34 операції · 12 400 ₴» відповідає на питання ще до кліку.
 */
api.get("/search", async (c) => {
  const q = (new URL(c.req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return c.json({ merchants: [], categories: [], transactions: [] });
  const rates = await getRates(c.env.DB);
  const { mult } = valueMode(rates, null);

  // ⚠️ SQLite згортає регістр ТІЛЬКИ для ASCII: `LOWER('Сільпо')` = `'Сільпо'` (перевірено
  // на D1). Тобто `LIKE '%сільпо%'` НІКОЛИ не знайде «Сільпо» — а це основна мова застосунку,
  // тож наївний LIKE зробив би пошук марним. Складаємо регістрові варіанти в JS (він
  // Unicode-aware) і матчимо через OR. Покриває реальні введення: усе малими, усе великими,
  // з великої літери. Екзотичний внутрішній регістр («МакДональдз» на запит «макдональдз»)
  // лишається поза — це свідомий компроміс проти сканування всієї таблиці на кожну літеру.
  const variants = [...new Set([q, q.toLocaleLowerCase("uk"), q.toLocaleUpperCase("uk"),
    q.charAt(0).toLocaleUpperCase("uk") + q.slice(1).toLocaleLowerCase("uk")])];

  return c.json(await txRepo.search(c.env.DB, c.get("locale"), mult, variants));
});

// §A5: корпус знань — вбудовані доки + користувацький шар (`knowledge_docs`, міграція 0028).
// Тут лише транспорт; злиття/ліміти/локи — у `worker/lib/knowledge/index.ts`.
api.get("/knowledge", async (c) => {
  const { knowledgeMeta } = await import("../../lib/ai/knowledge/index.ts");
  return c.json(await knowledgeMeta(c.env.DB, c.get("locale")));
});

// Повний текст документа — для редактора. Для вбудованого без заміни віддає вбудований текст,
// щоб «редагувати» починалося з реального вмісту, а не з порожнечі.
api.get("/knowledge/:id", async (c) => {
  const { knowledgeBody } = await import("../../lib/ai/knowledge/index.ts");
  const doc = await knowledgeBody(c.env.DB, c.req.param("id"), c.get("locale"));
  if (!doc) return c.json({ error: st(c.get("locale"), "errDocNotFound") }, 404);
  return c.json(doc);
});

// Створити власну нотатку. Ліміти — щоб корпус (він їде в КОЖЕН виклик чату) не розповзався.
api.post("/knowledge", async (c) => {
  const { DOC_MAX_CHARS, USER_TOTAL_MAX_CHARS, userCharsExcept } = await import("../../lib/ai/knowledge/index.ts");
  const b = await c.req.json<{ title?: string; summary?: string; body?: string }>();
  const title = (b.title ?? "").trim();
  const body = (b.body ?? "").trim();
  if (!title) return c.json({ error: st(c.get("locale"), "errDocTitleRequired") }, 400);
  if (!body) return c.json({ error: st(c.get("locale"), "errDocEmpty") }, 400);
  if (body.length > DOC_MAX_CHARS) return c.json({ error: st(c.get("locale"), "errDocTooLong", { len: body.length, max: DOC_MAX_CHARS }) }, 400);
  const used = await userCharsExcept(c.env.DB);
  if (used + body.length > USER_TOTAL_MAX_CHARS) {
    return c.json({ error: st(c.get("locale"), "errCorpusFullEdit", { used: used + body.length, max: USER_TOTAL_MAX_CHARS }) }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const id = `user:${now}:${Math.random().toString(36).slice(2, 7)}`;
  await knowledgeRepo.createUserDoc(
    c.env.DB, id, title, (b.summary ?? "").trim().slice(0, 200), body, now);
  return c.json({ ok: true, id });
});

// Зберегти: власну нотатку — як є; вбудований док — як override (крім locked).
api.put("/knowledge/:id", async (c) => {
  const { KNOWLEDGE_DOCS, DOC_MAX_CHARS, USER_TOTAL_MAX_CHARS, userCharsExcept, isLocked } = await import("../../lib/ai/knowledge/index.ts");
  const id = c.req.param("id");
  const b = await c.req.json<{ title?: string; summary?: string; body?: string; enabled?: boolean }>();
  const base = KNOWLEDGE_DOCS.find((d) => d.id === id);
  // Канон розрахунків не редагується: інакше AI пояснював би цифри не так, як їх рахує код.
  if (isLocked(id)) return c.json({ error: st(c.get("locale"), "errDocLocked") }, 400);
  if (!base && !id.startsWith("user:")) return c.json({ error: st(c.get("locale"), "errDocNotFound") }, 404);

  const body = (b.body ?? "").trim();
  if (!body) return c.json({ error: st(c.get("locale"), "errDocEmpty") }, 400);
  if (body.length > DOC_MAX_CHARS) return c.json({ error: st(c.get("locale"), "errDocTooLong", { len: body.length, max: DOC_MAX_CHARS }) }, 400);
  if (!base) {
    const used = await userCharsExcept(c.env.DB, id);
    if (used + body.length > USER_TOTAL_MAX_CHARS) {
      return c.json({ error: st(c.get("locale"), "errCorpusFull", { used: used + body.length, max: USER_TOTAL_MAX_CHARS }) }, 400);
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const title = (b.title ?? base?.title ?? "").trim();
  if (!title) return c.json({ error: st(c.get("locale"), "errDocTitleRequired") }, 400);
  const kind = base ? "override" : "user";
  const enabled = b.enabled === false ? 0 : 1;
  await knowledgeRepo.upsert(
    c.env.DB, id, kind, title, (b.summary ?? base?.summary ?? "").trim().slice(0, 200), body, enabled, now);
  return c.json({ ok: true, id });
});

// Видалити власну нотатку АБО повернути вбудований док до заводського тексту.
api.delete("/knowledge/:id", async (c) => {
  const { isLocked } = await import("../../lib/ai/knowledge/index.ts");
  const id = c.req.param("id");
  if (isLocked(id)) return c.json({ error: st(c.get("locale"), "errDocCannotHide") }, 400);
  await knowledgeRepo.remove(c.env.DB, id);
  return c.json({ ok: true });
});

api.post("/facts", async (c) => {
  const { addFact } = await import("../../lib/ai/advisor.ts");
  const b = await c.req.json<{
    text?: string; effective_from?: number; expires_at?: number | null;
    category_id?: number | null; adjust_kind?: "multiplier" | "delta_minor" | null;
    adjust_value?: number | null; confirm?: boolean;
  }>();
  if (!b.text?.trim()) return c.json({ error: "text required" }, 400);
  try {
    return c.json(await addFact(c.env, { ...b, text: b.text, source: "user" }));
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
});

api.post("/facts/:id/confirm", async (c) => {
  const { confirmFact } = await import("../../lib/ai/advisor.ts");
  const on = (await c.req.json<{ on?: boolean }>().catch(() => ({ on: true }))).on !== false;
  await confirmFact(c.env, Number(c.req.param("id")), on);
  return c.json({ ok: true });
});

api.delete("/facts/:id", async (c) => {
  const { deleteFact } = await import("../../lib/ai/advisor.ts");
  await deleteFact(c.env, Number(c.req.param("id")));
  return c.json({ ok: true });
});

// §GR2: AI-оцінка групи (структуровані факти) + чат по конкретній групі.
api.post("/events/:id/ai", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { evaluateGroupAdvice } = await import("../../lib/ai/advisor.ts");
  try {
    const r = await evaluateGroupAdvice(c.env, Number(c.req.param("id")));
    return r ? c.json(r) : c.json({ error: "not_found" }, 404);
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

api.post("/events/:id/chat", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const body = await c.req.json<{ messages?: { role: string; content: string }[] }>();
  const msgs = normChatMessages(body.messages);
  if (!msgs.length) return c.json({ error: "messages required" }, 400);
  const { chatAboutGroup } = await import("../../lib/ai/advisor.ts");
  try {
    return c.json(await chatAboutGroup(c.env, Number(c.req.param("id")), msgs));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// Інлайн-чат по конкретній операції: обговорити/уточнити з AI; він може оновити
// категорію чи прапорець переказу, коли з розмови стало ясно, що це.
api.post("/transactions/:id/chat", async (c) => {
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

// AI-план бюджету: пропозиції місячних лімітів-конвертів (приймаються на /plan).
api.post("/budgets/propose", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { proposeBudgets } = await import("../../lib/ai/advisor.ts");
  try {
    return c.json(await proposeBudgets(c.env));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §3 діалоговий бюджет: чат, у якому AI пропонує/коригує ліміти й пояснює чому.
api.post("/budgets/chat", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { messages } = await c.req.json<{ messages: { role: "user" | "assistant"; content: string }[] }>();
  const { budgetChatReply } = await import("../../lib/ai/advisor.ts");
  try {
    return c.json(await budgetChatReply(c.env, normChatMessages(messages)));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// ---- manual accounts (позамоно картка / крипта, §5) -------------------------

const MANUAL_TYPES = new Set(["manual_card", "crypto", "cash", "jar"]);
api.post("/accounts/manual", async (c) => {
  const b = await c.req.json<{
    type: string; title: string; currency_code: number; balance: number;
    role?: "liquid" | "investment"; credit_limit?: number; ai_note?: string;
  }>();
  const type = MANUAL_TYPES.has(b.type) ? b.type : "manual_card";
  const role = b.role === "investment" ? "investment" : "liquid";
  const creditLimit = typeof b.credit_limit === "number" && b.credit_limit > 0 ? Math.round(b.credit_limit) : 0;
  const aiNote = b.ai_note?.trim() || null;
  const id = crypto.randomUUID();
  const nowS = Math.floor(Date.now() / 1000);
  await accountsRepo.createManual(c.env.DB, {
    id, type, title: b.title, currency_code: b.currency_code, balance: b.balance,
    credit_limit: creditLimit, role, ai_note: aiNote, updated_at: nowS,
  });
  // Перший зріз балансу одразу: без нього нетворт не має від чого відштовхнутись і малює
  // рахунок так, ніби він зʼявився сьогодні.
  await accountsRepo.recordBalance(c.env.DB, id, b.balance, nowS);
  return c.json({ ok: true, id });
});

api.patch("/accounts/manual/:id", async (c) => {
  const b = await c.req.json<{ balance?: number; title?: string }>();
  const id = c.req.param("id");
  const nowS = Math.floor(Date.now() / 1000);
  await accountsRepo.updateManual(c.env.DB, id, b, nowS);
  // Зріз балансу в історію → нетворт крокує по ньому назад (не плоский). Лише коли баланс змінили:
  // перейменування — не подія балансу, і крок на графіку там означав би зміну, якої не було.
  if (b.balance !== undefined) await accountsRepo.recordBalance(c.env.DB, id, b.balance, nowS);
  return c.json({ ok: true });
});

// Cached rates map (currency code → UAH per unit) + last-updated, for client-side
// ≈₴ conversion of FX cards/jars. Same source computeSummary uses.
api.get("/rates", async (c) => {
  return c.json(await stateRepo.rates(c.env.DB));
});

// Перейменувати рахунок (напр. банку — mono дає generic «БАНКА»). Title — лише
// показ, тож дозволяємо для будь-якого рахунку; синк банок його вже не перезапише.
api.patch("/accounts/:id/title", async (c) => {
  const { title } = await c.req.json<{ title?: string }>();
  if (!title?.trim()) return c.json({ error: "title required" }, 400);
  await accountsRepo.rename(c.env.DB, c.req.param("id"), title.trim());
  return c.json({ ok: true });
});

// §R3: роль рахунку (ліквідний/інвестиційний) + опис для AI. Для будь-якого рахунку.
// + умови кредитки (statement_day/payment_day/min_payment) — живлять нагадування про платіж.
api.patch("/accounts/:id/meta", async (c) => {
  const b = await c.req.json<{ role?: "liquid" | "investment"; ai_note?: string; statement_day?: number | null; payment_day?: number | null; min_payment?: number | null }>();
  // День місяця валідуємо 1..31; порожнє/некоректне → NULL (умову знято): нагадування «на 40-те
  // число» не спрацювало б ніколи, тобто виглядало б налаштованим, будучи мертвим.
  const dayOrNull = (v: number | null | undefined) => (typeof v === "number" && v >= 1 && v <= 31 ? Math.trunc(v) : null);
  await accountsRepo.updateMeta(c.env.DB, c.req.param("id"), {
    ...(b.role !== undefined ? { role: b.role === "investment" ? "investment" : "liquid" } : {}),
    ...(b.ai_note !== undefined ? { ai_note: b.ai_note.trim() || null } : {}),
    ...(b.statement_day !== undefined ? { statement_day: dayOrNull(b.statement_day) } : {}),
    ...(b.payment_day !== undefined ? { payment_day: dayOrNull(b.payment_day) } : {}),
    ...(b.min_payment !== undefined
      ? { min_payment: typeof b.min_payment === "number" && b.min_payment > 0 ? Math.round(b.min_payment) : null } : {}),
  });
  return c.json({ ok: true });
});

// Архів/відновлення рахунку (is_active). Схований рахунок не показується й не входить у
// підсумки/подушку/нетворт. Історію операцій НЕ чіпаємо — лише ховаємо рахунок зі списку.
api.patch("/accounts/:id/active", async (c) => {
  const { active } = await c.req.json<{ active: boolean }>();
  await accountsRepo.setActive(c.env.DB, c.req.param("id"), active);
  return c.json({ ok: true });
});

// Видалення РУЧНОГО рахунку — лише якщо на ньому немає операцій (інакше лишились би
// сирітські tx / FK). Для mono-рахунків видалення нема — тільки архів вище.
api.delete("/accounts/:id", async (c) => {
  const id = c.req.param("id");
  const acc = await accountsRepo.findKind(c.env.DB, id);
  if (!acc) return c.json({ error: st(c.get("locale"), "errAccountNotFound") }, 404);
  if (!acc.is_manual) return c.json({ error: st(c.get("locale"), "errAccountOnlyManual") }, 400);
  if (await accountsRepo.transactionCount(c.env.DB, id) > 0) {
    return c.json({ error: st(c.get("locale"), "errAccountHasTx") }, 400);
  }
  await accountsRepo.removeManual(c.env.DB, id);
  return c.json({ ok: true });
});

// Ручний тригер проактивного TG-пушу (тест без очікування тижневого крону).
api.post("/tg/proactive", async (c) => {
  const { runWeeklyProactive } = await import("../../lib/messaging/proactive.ts");
  try {
    return c.json(await runWeeklyProactive(c.env));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §F2 крок 2: скан вагомих непояснених операцій за 14 днів → TG-алерти (ручний тест/фолбек).
api.post("/alerts/scan", async (c) => {
  const { scanAlerts } = await import("../../lib/messaging/alert.ts");
  try {
    return c.json(await scanAlerts(c.env, new URL(c.req.url).origin));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// Refresh currency rates cache from public mono endpoint (call daily / on demand).
api.post("/rates/refresh", async (c) => {
  const { getCurrencyRates } = await import("../../lib/bank/mono.ts");
  try {
    const rates = await getCurrencyRates();
    const map: Record<string, number> = {};
    for (const r of rates) {
      if (r.currencyCodeB === 980 && r.rateSell) map[String(r.currencyCodeA)] = r.rateSell;
      else if (r.currencyCodeB === 980 && r.rateCross) map[String(r.currencyCodeA)] = r.rateCross;
    }
    await setState(c.env.DB, "rates", JSON.stringify(map));
    await setState(c.env.DB, "rates_updated", String(Math.floor(Date.now() / 1000)));
    return c.json({ ok: true, rates: map });
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});
