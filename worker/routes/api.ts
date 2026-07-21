// Core REST API for the dashboard. All money is minor units; the client divides by 100.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { setState, getState } from "../lib/repo.ts";
import { computeSummary, createCashTx, getRates, toUAHMinor, ratesForDays, type Rates } from "../lib/finance.ts";
import {
  STATS_JOINS, EFF_CAT_ID, EFF_CAT_NAME, EFF_CAT_COLOR, EFF_IMPORTANCE, EFF_AMOUNT, SPEND_WHERE, INCOME_WHERE,
  SPEND_COUNT, valueMode, uahMult, spendSum, incomeSum, amountSum, periodBounds,
  recurringOneoffSplit, defaultRefFrom, isRecurringExpr, projectSpend, categoryMonthlyLevels,
  type PeriodMode, type Preset,
} from "../lib/stats.ts";

export const api = new Hono<{ Bindings: Env }>();

// §6 Вагомість: приймаємо лише валідні рівні; будь-що інше (вкл. "" / null) → NULL (скидання).
const IMPORTANCE = new Set(["essential", "discretionary", "optional"]);
function normImportance(v: string | null | undefined): string | null {
  return v && IMPORTANCE.has(v) ? v : null;
}

// ---- reference data ---------------------------------------------------------

api.get("/categories", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM categories ORDER BY is_income, id").all();
  return c.json(rows.results);
});

api.get("/accounts", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM accounts WHERE is_active = 1 ORDER BY is_manual, type",
  ).all();
  return c.json(rows.results);
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

  const where: string[] = [];
  const binds: unknown[] = [];
  // §R5: пара-переказ показується ОДНИМ рядком — ховаємо вхідну (+) сторону пари.
  where.push("NOT (t.transfer_pair_id IS NOT NULL AND t.amount > 0)");
  if (category) { where.push("t.category_id = ?"); binds.push(Number(category)); }
  if (catparent) { where.push("COALESCE(c.parent_id, t.category_id) = ?"); binds.push(Number(catparent)); }
  if (type === "expense") where.push("t.amount < 0");
  if (type === "income") where.push("t.amount > 0");
  if (account) { where.push("t.account_id = ?"); binds.push(account); }
  if (from) { where.push("t.time >= ?"); binds.push(Number(from)); }
  if (to) { where.push("t.time <= ?"); binds.push(Number(to)); }
  // Сума порівнюється по модулю (₴→копійки). Мультивалюта не зводиться — фільтр по номіналу рахунку.
  if (amin) { where.push("ABS(t.amount) >= ?"); binds.push(Math.round(Number(amin) * 100)); }
  if (amax) { where.push("ABS(t.amount) <= ?"); binds.push(Math.round(Number(amax) * 100)); }
  if (q) { where.push("(t.merchant LIKE ? OR t.comment LIKE ? OR t.user_note LIKE ? OR e.name LIKE ?)"); binds.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Друга сторона пари-переказу → маршрут «звідки → куди» в рядку. `tp.transfer_pair_id =
  // t.transfer_pair_id` не з'єднує нічого, коли pair_id NULL (NULL = NULL хибне), тож
  // звичайні операції join не чіпає.
  const rows = await c.env.DB.prepare(
    `SELECT t.*, c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
            a.title AS account_title, e.name AS event_name, e.color AS event_color,
            ap.title AS pair_account_title
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN event_groups e ON e.id = t.event_id
     LEFT JOIN transactions tp ON tp.transfer_pair_id = t.transfer_pair_id AND tp.id <> t.id
     LEFT JOIN accounts ap ON ap.id = tp.account_id
     ${clause}
     ORDER BY t.time DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all();
  return c.json(rows.results);
});

// §J: CSV-експорт транзакцій (для бухгалтера/податкової). Опційні from/to (unix). BOM для
// коректної кирилиці в Excel; сума — у валюті рахунку. Пара-переказ — один рядок (як у списку).
const CUR_ALPHA: Record<number, string> = { 980: "UAH", 840: "USD", 978: "EUR", 985: "PLN", 826: "GBP", 756: "CHF" };
api.get("/export/transactions.csv", async (c) => {
  const url = new URL(c.req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const where: string[] = ["NOT (t.transfer_pair_id IS NOT NULL AND t.amount > 0)"];
  const binds: unknown[] = [];
  if (from) { where.push("t.time >= ?"); binds.push(Number(from)); }
  if (to) { where.push("t.time <= ?"); binds.push(Number(to)); }
  const rows = await c.env.DB.prepare(
    `SELECT t.time, t.merchant, t.comment, t.user_note, t.amount, t.currency_code, t.is_transfer,
            c.name AS category_name, a.title AS account_title, e.name AS event_name
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN event_groups e ON e.id = t.event_id
     WHERE ${where.join(" AND ")}
     ORDER BY t.time DESC LIMIT 20000`,
  ).bind(...binds).all<{
    time: number; merchant: string | null; comment: string | null; user_note: string | null;
    amount: number; currency_code: number; is_transfer: number;
    category_name: string | null; account_title: string | null; event_name: string | null;
  }>();
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["Дата", "Мерчант", "Коментар", "Нотатка", "Сума", "Валюта", "Категорія", "Рахунок", "Група", "Переказ"];
  const lines = [header.join(",")];
  for (const r of rows.results ?? []) {
    lines.push([
      new Date(r.time * 1000).toISOString().slice(0, 10),
      r.merchant ?? "", r.comment ?? "", r.user_note ?? "",
      (r.amount / 100).toFixed(2), CUR_ALPHA[r.currency_code] ?? String(r.currency_code),
      r.category_name ?? "", r.account_title ?? "", r.event_name ?? "",
      r.is_transfer ? "так" : "",
    ].map(esc).join(","));
  }
  const csv = "﻿" + lines.join("\r\n");
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

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b.event_id !== undefined) { sets.push("event_id = ?"); vals.push(b.event_id); }
  if (b.category_id !== undefined) { sets.push("category_id = ?"); vals.push(b.category_id); }
  if (b.is_transfer !== undefined) { sets.push("is_transfer = ?"); vals.push(b.is_transfer ? 1 : 0); }
  // §6 вагомість: null = зняти override операції (успадкує від категорії). Чужі значення
  // не пускаємо — вони мовчки випали б з `EFF_IMPORTANCE` і зіпсували всю аналітику вагомості.
  if (b.importance !== undefined) {
    if (b.importance !== null && !["essential", "discretionary", "optional"].includes(b.importance)) {
      return c.json({ error: "invalid importance" }, 400);
    }
    sets.push("importance = ?"); vals.push(b.importance);
  }

  // §FK-GUARD: `INSERT OR IGNORE` гасить лише конфлікт унікальності, а НЕ порушення FK —
  // один неіснуючий id тега завалив би весь батч у `FOREIGN KEY constraint failed`
  // (перевірено на D1). Тож фільтруємо теги по наявних категоріях перед записом.
  let validTags: number[] = [];
  if (b.tag_ids?.length) {
    const want = [...new Set(b.tag_ids)].filter((t): t is number => Number.isFinite(t));
    if (want.length) {
      const rows = await c.env.DB.prepare(
        `SELECT id FROM categories WHERE id IN (${want.map(() => "?").join(",")})`,
      ).bind(...want).all<{ id: number }>();
      validTags = (rows.results ?? []).map((r) => r.id);
    }
  }
  if (!sets.length && !validTags.length) return c.json({ ok: true, updated: 0 });

  let updated = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const ph = chunk.map(() => "?").join(",");
    if (sets.length) {
      const r = await c.env.DB.prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id IN (${ph})`)
        .bind(...vals, ...chunk).run();
      updated += r.meta.changes ?? 0;
    }
    // Теги — окрема таблиця many-to-many. ДОДАЄМО, не заміщаємо: гуртова дія «повісити тег»
    // не повинна тихо знести теги, розставлені поштучно. Зняття — з деталей операції.
    if (validTags.length) {
      const tags = validTags;
      {
        await c.env.DB.batch(chunk.flatMap((id) => tags.map((tag) =>
          c.env.DB.prepare("INSERT OR IGNORE INTO transaction_tags (transaction_id, category_id) VALUES (?, ?)").bind(id, tag),
        )));
        if (!sets.length) updated += chunk.length;
      }
    }
  }
  return c.json({ ok: true, updated });
});

// Single transaction with joined names + attached receipt (for the detail page).
api.get("/transactions/:id", async (c) => {
  const id = c.req.param("id");
  const tx = await c.env.DB.prepare(
    `SELECT t.*, c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
            rc.name AS real_category_name, rc.color AS real_category_color,
            a.title AS account_title, a.type AS account_type,
            e.name AS event_name, e.color AS event_color,
            p.title AS planned_title,
            ap.title AS pair_account_title
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN categories rc ON rc.id = t.real_category_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN event_groups e ON e.id = t.event_id
     LEFT JOIN planned_payments p ON p.id = t.planned_id
     LEFT JOIN transactions tp ON tp.transfer_pair_id = t.transfer_pair_id AND tp.id <> t.id
     LEFT JOIN accounts ap ON ap.id = tp.account_id
     WHERE t.id = ?`,
  ).bind(id).first();
  if (!tx) return c.json({ error: "not_found" }, 404);

  let receipt = null;
  if ((tx as { receipt_id: number | null }).receipt_id) {
    const r = await c.env.DB.prepare("SELECT * FROM receipts WHERE id = ?")
      .bind((tx as { receipt_id: number }).receipt_id).first();
    if (r) {
      const items = await c.env.DB.prepare("SELECT * FROM receipt_items WHERE receipt_id = ?")
        .bind((tx as { receipt_id: number }).receipt_id).all();
      receipt = { ...r, items: items.results ?? [] };
    }
  }
  const tags = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.color FROM transaction_tags tt JOIN categories c ON c.id = tt.category_id
     WHERE tt.transaction_id = ?`,
  ).bind(id).all();
  return c.json({ ...tx, receipt, tags: tags.results ?? [] });
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

// Edit + optional "apply to all like this" learning (§6.3). When learn=true and the
// tx came from mono, we store a merchant_alias keyed on the raw mono description.
api.patch("/transactions/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<{
    category_id?: number | null; merchant?: string; user_note?: string; learn?: boolean;
    is_transfer?: boolean; tags?: number[]; event_id?: number | null; real_category_id?: number | null;
    importance?: string | null; lock_name?: boolean;
  }>();

  const tx = await c.env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first<{
    source: string; raw_json: string | null; comment: string | null; mcc: number | null; merchant: string | null;
  }>();
  if (!tx) return c.json({ error: "not_found" }, 404);

  // §R7: ручна назва авторитетна. Ставимо name_locked=1, коли користувач змінив назву на
  // непорожню й іншу; явний lock_name (кнопка «дозволити AI змінювати») може зняти/поставити.
  const renamed = b.merchant !== undefined && !!b.merchant?.trim() && b.merchant.trim() !== (tx.merchant ?? "").trim();

  // Теги (вторинні категорії, до 3, без основної) — повна заміна набору.
  if (b.tags !== undefined) {
    await c.env.DB.prepare("DELETE FROM transaction_tags WHERE transaction_id = ?").bind(id).run();
    const tags = [...new Set(b.tags)].filter((t) => t !== b.category_id).slice(0, 3);
    for (const t of tags) {
      await c.env.DB.prepare("INSERT OR IGNORE INTO transaction_tags (transaction_id, category_id) VALUES (?, ?)").bind(id, t).run();
    }
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (b.category_id !== undefined) { sets.push("category_id = ?"); binds.push(b.category_id); }
  if (b.merchant !== undefined) { sets.push("merchant = ?"); binds.push(b.merchant); }
  if (b.user_note !== undefined) { sets.push("user_note = ?"); binds.push(b.user_note); }
  if (b.is_transfer !== undefined) { sets.push("is_transfer = ?"); binds.push(b.is_transfer ? 1 : 0); }
  if (b.real_category_id !== undefined) { sets.push("real_category_id = ?"); binds.push(b.real_category_id); }
  if (b.event_id !== undefined) { sets.push("event_id = ?"); binds.push(b.event_id); }
  if (b.importance !== undefined) { sets.push("importance = ?"); binds.push(normImportance(b.importance)); }
  if (b.lock_name !== undefined) { sets.push("name_locked = ?"); binds.push(b.lock_name ? 1 : 0); }
  else if (renamed) { sets.push("name_locked = ?"); binds.push(1); }
  if (sets.length) {
    await c.env.DB.prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  }

  // §R2-TX4: «реальна категорія» має сенс лише для бакета «Перекази і зняття».
  // Для звичайних операцій прибираємо її, щоб не дублювала основну й не плутала.
  await c.env.DB.prepare(
    `UPDATE transactions SET real_category_id = NULL
     WHERE id = ? AND is_transfer = 0 AND real_category_id IS NOT NULL
       AND COALESCE(
             (SELECT COALESCE(cat.parent_id, cat.id) FROM categories cat WHERE cat.id = transactions.category_id),
             -1
           ) != 13`,
  ).bind(id).run();

  let learned = false;
  if (b.learn) {
    const raw = tx.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }) : null;
    const rawKey = raw?.description?.trim();
    if (rawKey) {
      const transferFlag = b.is_transfer ? 1 : 0;
      // Реальну категорію переказу зберігаємо в alias; якщо цього разу її не передали —
      // не губимо раніше навчену (беремо з наявного alias).
      const prior = await c.env.DB.prepare(
        "SELECT real_category_id FROM merchant_aliases WHERE match_type = 'mono_desc' AND raw_key = ? ORDER BY created_at DESC LIMIT 1",
      ).bind(rawKey).first<{ real_category_id: number | null }>();
      const realCat = b.real_category_id !== undefined ? b.real_category_id : (prior?.real_category_id ?? null);
      // Idempotent: one alias per raw description — a re-edit replaces the old rule.
      // §Хвіст: source='manual' — ця правка захищена, enrich/консенсус її не перетруть.
      await c.env.DB.prepare("DELETE FROM merchant_aliases WHERE match_type = 'mono_desc' AND raw_key = ?").bind(rawKey).run();
      await c.env.DB.prepare(
        `INSERT INTO merchant_aliases (match_type, raw_key, display_name, category_id, is_transfer, real_category_id, source, created_at)
         VALUES ('mono_desc', ?, ?, ?, ?, ?, 'manual', ?)`,
      )
        .bind(rawKey, b.merchant ?? null, b.category_id ?? null, transferFlag, realCat, Math.floor(Date.now() / 1000))
        .run();
      // Back-apply to existing matching mono transactions (name, category, transfer flag, real category).
      await c.env.DB.prepare(
        `UPDATE transactions SET category_id = COALESCE(?, category_id), merchant = COALESCE(?, merchant),
                                 is_transfer = ?, real_category_id = COALESCE(?, real_category_id)
         WHERE source = 'mono' AND json_extract(raw_json, '$.description') = ?`,
      )
        .bind(b.category_id ?? null, b.merchant ?? null, transferFlag, realCat, rawKey)
        .run();
      learned = true;
    }
  }
  return c.json({ ok: true, learned });
});

// ---- budgets & planned ------------------------------------------------------

api.get("/budgets", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM budgets").all();
  return c.json(rows.results);
});

// Idempotent set: one budget per category+period. amount<=0 clears it. No unique
// index on the table, so replace by delete-then-insert in a batch.
api.put("/budgets", async (c) => {
  const b = await c.req.json<{ category_id: number; period: "month" | "week"; amount: number; rollover?: boolean }>();
  const del = c.env.DB.prepare("DELETE FROM budgets WHERE category_id = ? AND period = ?")
    .bind(b.category_id, b.period);
  if (b.amount > 0) {
    await c.env.DB.batch([
      del,
      c.env.DB.prepare("INSERT INTO budgets (category_id, period, amount, currency_code, rollover) VALUES (?, ?, ?, 980, ?)")
        .bind(b.category_id, b.period, b.amount, b.rollover ? 1 : 0),
    ]);
  } else {
    await del.run();
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

  const [levels, cats, existing] = await Promise.all([
    categoryMonthlyLevels(c.env, mult, { now }),
    c.env.DB.prepare(
      `SELECT c.id, c.name, c.color, c.importance FROM categories c
       WHERE c.parent_id IS NULL AND COALESCE(c.is_income, 0) = 0`,
    ).all<{ id: number; name: string; color: string | null; importance: string | null }>(),
    c.env.DB.prepare("SELECT category_id, amount FROM budgets WHERE period = 'month'")
      .all<{ category_id: number; amount: number }>(),
  ]);
  const currentByCat = new Map((existing.results ?? []).map((b) => [b.category_id, b.amount]));

  const MIN_LEVEL = 30000; // 300 ₴/міс — дрібним категоріям конверт не потрібен
  const items = (cats.results ?? [])
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
  if (!items.length) return c.json({ error: "Нема що застосовувати" }, 400);

  // Той самий delete-then-insert, що й у PUT /budgets (унікального індексу на таблиці нема).
  const stmts = items.flatMap((i) => [
    c.env.DB.prepare("DELETE FROM budgets WHERE category_id = ? AND period = 'month'").bind(i.category_id),
    c.env.DB.prepare("INSERT INTO budgets (category_id, period, amount, currency_code, rollover) VALUES (?, 'month', ?, 980, 0)")
      .bind(i.category_id, i.amount),
  ]);
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, applied: items.length });
});

// §Хвіст C: глобальний лічильник витрат AI — «$ за сьогодні / цей місяць / за весь час».
api.get("/ai-usage", async (c) => {
  const { readUsageStats } = await import("../lib/ai.ts");
  return c.json(await readUsageStats(c.env));
});

// §Хвіст: факт vs план по підписках — фактичні списання, лічильник, ознака подорожчання.
api.get("/planned/actuals", async (c) => {
  const { plannedActuals } = await import("../lib/subscriptions.ts");
  return c.json(await plannedActuals(c.env.DB));
});

// §Аналітика 2.0 — AI-репорти (щотижня/щомісяця, історія зберігається).
api.get("/reports", async (c) => {
  const url = new URL(c.req.url);
  const type = url.searchParams.get("type");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 24), 60);
  const where = type === "week" || type === "month" ? "WHERE period_type = ?" : "";
  const binds = where ? [type, limit] : [limit];
  const rows = await c.env.DB.prepare(
    `SELECT id, period_type, period_from, period_to, created_at, model, cost_usd, summary
     FROM ai_reports ${where} ORDER BY period_to DESC, created_at DESC LIMIT ?`,
  ).bind(...binds).all();
  return c.json(rows.results ?? []);
});

api.get("/reports/:id", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id, period_type, period_from, period_to, created_at, model, cost_usd, summary, data_json FROM ai_reports WHERE id = ?",
  ).bind(c.req.param("id")).first<{ data_json: string } & Record<string, unknown>>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const { data_json, ...meta } = row;
  return c.json({ ...meta, data: JSON.parse(data_json) });
});

// Видалити репорт (напр. тестові генерації). Ідемпотентно — 404 не критично.
api.delete("/reports/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM ai_reports WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// Згенерувати репорт на вимогу (кнопка). type=week|month; scope=current(дефолт, для тесту —
// поточний період до сьогодні) | last (завершений, як у крона); force перегенеровує наявний.
api.post("/reports/generate", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const { type, force, scope } = await c.req.json<{ type?: "week" | "month"; force?: boolean; scope?: "current" | "last" }>().catch(() => ({ type: undefined, force: undefined, scope: undefined }));
  const t = type === "month" ? "month" : "week";
  try {
    const { generateAndStoreReport } = await import("../lib/report.ts");
    const res = await generateAndStoreReport(c.env, t, { force: force ?? true, scope: scope === "last" ? "last" : "current" });
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

api.get("/planned", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM planned_payments WHERE is_active = 1").all();
  return c.json(rows.results);
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
  const r = await c.env.DB.prepare(
    `INSERT INTO planned_payments (title, kind, total_amount, period_amount, period, period_count, start_date, end_date, occurrences, category_id, account_id, currency_code, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(b.title, b.kind, b.total_amount ?? null, b.period_amount ?? null, b.period, periodCount,
          b.start_date, end_date, occurrences, b.category_id ?? null, b.account_id ?? null, b.currency_code ?? 980)
    .run();
  return c.json({ ok: true, id: r.meta.last_row_id, occurrences, end_date });
});

// AI-детект підписки за описом (§F4): користувач описує словами → AI дістає пошуковий
// запит; шукаємо схожі транзакції, рахуємо середню суму/валюту/каденцію → кандидат.
api.post("/planned/ai-detect", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const { description } = await c.req.json<{ description?: string }>();
  if (!description?.trim()) return c.json({ error: "description required" }, 400);

  const { callHaikuJson, MODEL_SMART } = await import("../lib/ai.ts");
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
  const rows = await c.env.DB.prepare(
    `SELECT t.merchant, t.currency_code, -AVG(t.amount) AS avg_amount, COUNT(*) AS n,
            MIN(t.time) AS first_time, MAX(t.time) AS last_time,
            (SELECT x.category_id FROM transactions x
             WHERE x.merchant = t.merchant AND x.category_id IS NOT NULL
             GROUP BY x.category_id ORDER BY COUNT(*) DESC LIMIT 1) AS category_id
     FROM transactions t
     WHERE t.amount < 0 AND t.is_transfer = 0 AND t.hold = 0 AND t.merchant LIKE ? AND t.time >= ?
     GROUP BY t.merchant, t.currency_code
     HAVING n >= 1 ORDER BY n DESC, last_time DESC LIMIT 8`,
  ).bind(`%${query}%`, since).all<{ merchant: string; currency_code: number; avg_amount: number; n: number; first_time: number; last_time: number; category_id: number | null }>();

  const candidates = (rows.results ?? []).map((r) => ({
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
  await c.env.DB.prepare("UPDATE planned_payments SET is_active = 0 WHERE id = ?")
    .bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// §R5: редагувати підписку (наразі — опис для AI; розширювано за потреби).
api.patch("/planned/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ note?: string | null; category_id?: number | null }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (b.note !== undefined) { sets.push("note = ?"); binds.push(b.note?.trim() || null); }
  if (b.category_id !== undefined) { sets.push("category_id = ?"); binds.push(b.category_id); }
  if (!sets.length) return c.json({ ok: true });
  await c.env.DB.prepare(`UPDATE planned_payments SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  return c.json({ ok: true });
});

// §R5: закрити кандидата в підписки («це не підписка») — детект більше не пропонує.
api.post("/planned/dismiss", async (c) => {
  const { merchant } = await c.req.json<{ merchant?: string }>();
  if (!merchant?.trim()) return c.json({ error: "merchant required" }, 400);
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO planned_dismissed (merchant, created_at) VALUES (?, ?)",
  ).bind(merchant.trim().toLowerCase(), Math.floor(Date.now() / 1000)).run();
  return c.json({ ok: true });
});

// Ре-світ: виправити категорію наявних операцій, що підпадають під активну підписку,
// але зараз розкладені інакше (fix для вже неправильних, як Apple $1 у «Розвагах»). Без AI.
api.post("/planned/apply-categories", async (c) => {
  const { applySubscriptionCategories } = await import("../lib/subscriptions.ts");
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
  const rows = await c.env.DB.prepare(
    `SELECT t.merchant, -t.amount AS amount, COUNT(*) AS n,
            MIN(t.time) AS first_time, MAX(t.time) AS last_time,
            COUNT(DISTINCT strftime('%Y-%m', t.time, 'unixepoch')) AS months,
            t.currency_code AS currency_code,
            (SELECT x.category_id FROM transactions x
             WHERE x.merchant = t.merchant AND x.amount = t.amount AND x.category_id IS NOT NULL
             GROUP BY x.category_id ORDER BY COUNT(*) DESC LIMIT 1) AS category_id
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.amount < 0 AND t.hold = 0 AND t.is_transfer = 0
       AND t.merchant IS NOT NULL AND t.merchant <> '' AND t.time >= ?
       AND COALESCE(c.parent_id, t.category_id) IS NOT 13
     GROUP BY t.merchant, t.amount
     HAVING n >= 2 AND months >= 2
     ORDER BY n DESC, last_time DESC LIMIT 40`,
  ).bind(since).all<{ merchant: string; amount: number; n: number; first_time: number; last_time: number; months: number; currency_code: number; category_id: number | null }>();

  const declared = await c.env.DB.prepare(
    "SELECT LOWER(title) AS title FROM planned_payments WHERE is_active = 1",
  ).all<{ title: string }>();
  const declaredSet = new Set((declared.results ?? []).map((d) => d.title));
  // §R5: виключаємо закриті користувачем кандидати («це не підписка»).
  const dismissed = await c.env.DB.prepare("SELECT merchant FROM planned_dismissed").all<{ merchant: string }>();
  const dismissedSet = new Set((dismissed.results ?? []).map((d) => d.merchant));

  const candidates = (rows.results ?? [])
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
  const mult = uahMult(rates);
  const rows = await c.env.DB.prepare(
    `SELECT e.*,
            COUNT(t.id) AS tx_count,
            CAST(ROUND(COALESCE(SUM(CASE WHEN t.amount < 0 THEN (-t.amount) * ${mult} ELSE 0 END), 0)) AS INTEGER) AS spent,
            CAST(ROUND(COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount * ${mult} ELSE 0 END), 0)) AS INTEGER) AS income
     FROM event_groups e
     LEFT JOIN transactions t ON t.event_id = e.id
     WHERE e.is_active = 1
     GROUP BY e.id ORDER BY e.created_at DESC`,
  ).all();
  return c.json(rows.results ?? []);
});

// Бюджет події («скільки закладаю на цю подорож»). amount<=0 або null — прибрати ліміт.
api.patch("/events/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ budget?: number | null; name?: string; note?: string | null }>()
    .catch(() => ({} as { budget?: number | null; name?: string; note?: string | null }));
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (b.budget !== undefined) {
    const v = b.budget == null || b.budget <= 0 ? null : Math.round(b.budget);
    sets.push("budget = ?"); binds.push(v);
  }
  if (b.name !== undefined && b.name.trim()) { sets.push("name = ?"); binds.push(b.name.trim()); }
  if (b.note !== undefined) { sets.push("note = ?"); binds.push(b.note?.trim() || null); }
  if (!sets.length) return c.json({ ok: true });
  await c.env.DB.prepare(`UPDATE event_groups SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  return c.json({ ok: true });
});

api.post("/events", async (c) => {
  const b = await c.req.json<{ name: string; kind?: string; color?: string; icon?: string; note?: string }>();
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  const r = await c.env.DB.prepare(
    `INSERT INTO event_groups (name, kind, color, icon, note, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).bind(b.name.trim(), b.kind ?? "event", b.color ?? null, b.icon ?? null, b.note ?? null, Math.floor(Date.now() / 1000)).run();
  return c.json({ ok: true, id: r.meta.last_row_id });
});

api.delete("/events/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("UPDATE transactions SET event_id = NULL WHERE event_id = ?").bind(id).run();
  await c.env.DB.prepare("UPDATE event_groups SET is_active = 0 WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// Деталь події: підсумок + список транзакцій.
api.get("/events/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const event = await c.env.DB.prepare("SELECT * FROM event_groups WHERE id = ?").bind(id).first();
  if (!event) return c.json({ error: "not_found" }, 404);
  // Підсумки рахує СЕРВЕР і зводить у ₴. Раніше сторінка рахувала їх сама, фільтруючи
  // `currency_code === 980`, тож валютні операції випадали — і та сама група показувала
  // на сторінці меншу суму, ніж у списку. Одна цифра має бути одна.
  const rates = await getRates(c.env.DB);
  const mult = uahMult(rates);
  const [txs, agg] = await Promise.all([
    c.env.DB.prepare(
      `SELECT t.*, c.name AS category_name, c.color AS category_color, a.title AS account_title
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.event_id = ? ORDER BY t.time DESC`,
    ).bind(id).all(),
    c.env.DB.prepare(
      `SELECT CAST(ROUND(COALESCE(SUM(CASE WHEN t.amount < 0 THEN (-t.amount) * ${mult} ELSE 0 END), 0)) AS INTEGER) AS spent,
              CAST(ROUND(COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount * ${mult} ELSE 0 END), 0)) AS INTEGER) AS income
       FROM transactions t WHERE t.event_id = ?`,
    ).bind(id).first<{ spent: number; income: number }>(),
  ]);
  return c.json({
    event, transactions: txs.results ?? [],
    spent: agg?.spent ?? 0, income: agg?.income ?? 0,
  });
});

// ---- savings goals (§7) -----------------------------------------------------

// Список цілей із прогресом. Якщо привʼязано банку (account_id) — прогрес = її баланс,
// інакше — ручний current_amount.
api.get("/goals", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT g.*, a.balance AS account_balance, a.title AS account_title
     FROM savings_goals g
     LEFT JOIN accounts a ON a.id = g.account_id
     WHERE g.is_active = 1 ORDER BY g.created_at DESC`,
  ).all<{ account_id: string | null; account_balance: number | null; current_amount: number }>();
  const goals = (rows.results ?? []).map((g) => ({
    ...g,
    current: g.account_id != null && g.account_balance != null ? g.account_balance : g.current_amount,
  }));
  return c.json(goals);
});

api.post("/goals", async (c) => {
  const b = await c.req.json<{ name: string; target_amount: number; current_amount?: number; account_id?: string | null; deadline?: number | null; color?: string; note?: string }>();
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  if (!(b.target_amount > 0)) return c.json({ error: "target required" }, 400);
  const r = await c.env.DB.prepare(
    `INSERT INTO savings_goals (name, target_amount, current_amount, account_id, deadline, color, note, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).bind(b.name.trim(), b.target_amount, b.current_amount ?? 0, b.account_id ?? null, b.deadline ?? null,
         b.color ?? "#2e6be6", b.note ?? null, Math.floor(Date.now() / 1000)).run();
  return c.json({ ok: true, id: r.meta.last_row_id });
});

api.patch("/goals/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ name?: string; target_amount?: number; current_amount?: number; account_id?: string | null; deadline?: number | null; color?: string; note?: string }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (b.name !== undefined) { if (!b.name.trim()) return c.json({ error: "name required" }, 400); sets.push("name = ?"); binds.push(b.name.trim()); }
  if (b.target_amount !== undefined) { sets.push("target_amount = ?"); binds.push(b.target_amount); }
  if (b.current_amount !== undefined) { sets.push("current_amount = ?"); binds.push(b.current_amount); }
  if (b.account_id !== undefined) { sets.push("account_id = ?"); binds.push(b.account_id); }
  if (b.deadline !== undefined) { sets.push("deadline = ?"); binds.push(b.deadline); }
  if (b.color !== undefined) { sets.push("color = ?"); binds.push(b.color); }
  if (b.note !== undefined) { sets.push("note = ?"); binds.push(b.note); }
  if (!sets.length) return c.json({ ok: true });
  await c.env.DB.prepare(`UPDATE savings_goals SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  return c.json({ ok: true });
});

api.delete("/goals/:id", async (c) => {
  await c.env.DB.prepare("UPDATE savings_goals SET is_active = 0 WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---- custom categories ------------------------------------------------------

api.post("/categories", async (c) => {
  const b = await c.req.json<{ name: string; color?: string; icon?: string; parent_id?: number | null; is_income?: boolean; importance?: string | null }>();
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  const r = await c.env.DB.prepare(
    "INSERT INTO categories (name, color, icon, parent_id, is_income, is_custom, importance) VALUES (?, ?, ?, ?, ?, 1, ?)",
  ).bind(b.name.trim(), b.color ?? "#6B7A74", b.icon ?? "dots", b.parent_id ?? null, b.is_income ? 1 : 0, normImportance(b.importance)).run();
  return c.json({ ok: true, id: r.meta.last_row_id });
});

// Редагувати будь-яку категорію (зокрема вбудовану): назва/колір/іконка/батько.
// Колонки вже є (міграція 0005), нової міграції не треба. parent_id=null → верхній рівень.
api.patch("/categories/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ name?: string; color?: string; icon?: string; parent_id?: number | null; importance?: string | null }>();
  const cat = await c.env.DB.prepare("SELECT id FROM categories WHERE id = ?").bind(id).first();
  if (!cat) return c.json({ error: "not_found" }, 404);

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (b.name !== undefined) {
    if (!b.name.trim()) return c.json({ error: "name required" }, 400);
    sets.push("name = ?"); binds.push(b.name.trim());
  }
  if (b.color !== undefined) { sets.push("color = ?"); binds.push(b.color); }
  if (b.icon !== undefined) { sets.push("icon = ?"); binds.push(b.icon); }
  if (b.importance !== undefined) { sets.push("importance = ?"); binds.push(normImportance(b.importance)); }
  // Не даємо категорії стати власним батьком (проста петля).
  if (b.parent_id !== undefined) { sets.push("parent_id = ?"); binds.push(b.parent_id === id ? null : b.parent_id); }
  if (!sets.length) return c.json({ ok: true });
  await c.env.DB.prepare(`UPDATE categories SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  return c.json({ ok: true });
});

// Видалити можна лише кастомну категорію; транзакції знеприв'язуються.
// Скільки всього прив'язано до категорії (для діалогу «куди перенести перед видаленням»).
api.get("/categories/:id/usage", async (c) => {
  const id = Number(c.req.param("id"));
  const tx = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE category_id = ? OR real_category_id = ?",
  ).bind(id, id).first<{ n: number }>();
  const tags = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM transaction_tags WHERE category_id = ?").bind(id).first<{ n: number }>();
  const subs = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM categories WHERE parent_id = ?").bind(id).first<{ n: number }>();
  return c.json({ transactions: tx?.n ?? 0, tags: tags?.n ?? 0, subcategories: subs?.n ?? 0 });
});

// Видалити категорію, перенісши всі прив'язки на іншу (reassign) або знявши їх (null).
// Захищена лише категорія «Перекази і зняття» (13) — на ній тримається логіка бакета.
api.delete("/categories/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (id === 13) return c.json({ error: "категорію «Перекази і зняття» видаляти не можна" }, 400);
  const cat = await c.env.DB.prepare("SELECT id FROM categories WHERE id = ?").bind(id).first();
  if (!cat) return c.json({ error: "not_found" }, 404);

  const raw = new URL(c.req.url).searchParams.get("reassign");
  const target = raw && raw !== "none" && Number(raw) !== id ? Number(raw) : null;

  try {
    // Транзакції: основна й реальна категорія.
    await c.env.DB.prepare("UPDATE transactions SET category_id = ? WHERE category_id = ?").bind(target, id).run();
    await c.env.DB.prepare("UPDATE transactions SET real_category_id = ? WHERE real_category_id = ?").bind(target, id).run();
    // Теги: перекидаємо на target (уникаючи дублів), або прибираємо.
    if (target != null) {
      await c.env.DB.prepare("DELETE FROM transaction_tags WHERE category_id = ? AND transaction_id IN (SELECT transaction_id FROM transaction_tags WHERE category_id = ?)").bind(id, target).run();
      await c.env.DB.prepare("UPDATE transaction_tags SET category_id = ? WHERE category_id = ?").bind(target, id).run();
    } else {
      await c.env.DB.prepare("DELETE FROM transaction_tags WHERE category_id = ?").bind(id).run();
    }
    // Навчені aliases (FK на categories) — саме через них падав 500, коли їх не чіпали.
    await c.env.DB.prepare("UPDATE merchant_aliases SET category_id = ? WHERE category_id = ?").bind(target, id).run();
    await c.env.DB.prepare("UPDATE merchant_aliases SET real_category_id = ? WHERE real_category_id = ?").bind(target, id).run();
    // Позиції чеків (FK на categories).
    await c.env.DB.prepare("UPDATE receipt_items SET category_id = ? WHERE category_id = ?").bind(target, id).run();
    // Правила (category_id NOT NULL): без цілі — видаляємо, інакше переносимо.
    if (target != null) {
      await c.env.DB.prepare("UPDATE rules SET category_id = ? WHERE category_id = ?").bind(target, id).run();
    } else {
      await c.env.DB.prepare("DELETE FROM rules WHERE category_id = ?").bind(id).run();
    }
    // Планові, бюджети, підкатегорії.
    await c.env.DB.prepare("UPDATE planned_payments SET category_id = ? WHERE category_id = ?").bind(target, id).run();
    await c.env.DB.prepare("UPDATE budgets SET category_id = ? WHERE category_id = ?").bind(target, id).run();
    await c.env.DB.prepare("UPDATE categories SET parent_id = ? WHERE parent_id = ?").bind(target, id).run();

    await c.env.DB.prepare("DELETE FROM categories WHERE id = ?").bind(id).run();
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

// ---- analytics --------------------------------------------------------------

// Aggregated analytics for the stats page: totals + prev-period comparison, a time
// series, and breakdowns by category / merchant / account. Per-currency (§5),
// transfers excluded. One call to keep the page snappy.
api.get("/analytics/overview", async (c) => {
  const url = new URL(c.req.url);
  const rates = await getRates(c.env.DB);
  const mode = ((await getState(c.env.DB, "period_mode")) as PeriodMode) || "calendar";
  const presetParam = url.searchParams.get("preset") as Preset | null;

  // Пресет (week|month|quarter|year) → канонічні межі за режимом period_mode; інакше
  // явні from/to (кастомні дрили). Так Головна і Статистика рахують ОДИН період.
  let from: number, to: number, prevFrom: number, prevTo: number, bucket: string;
  if (presetParam && ["week", "month", "quarter", "year"].includes(presetParam)) {
    const b = periodBounds(mode, presetParam);
    ({ from, to, prevFrom, prevTo, bucket } = b);
  } else {
    to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
    from = Number(url.searchParams.get("from") ?? to - 30 * 86400);
    const span = to - from;
    prevFrom = from - span; prevTo = from;
    bucket = url.searchParams.get("bucket") ?? "day";
  }
  // Валюта: за замовч. зведено в ₴; ?currency=NNN → «чиста» валюта.
  const curParam = url.searchParams.get("currency");
  const cur = curParam ? Number(curParam) : null;
  const { mult, curFilter } = valueMode(rates, cur);
  const fmt = bucket === "month" ? "%Y-%m" : bucket === "week" ? "%Y-W%W" : "%Y-%m-%d";

  const totals = (f: number, t: number) => c.env.DB.prepare(
    `SELECT ${spendSum(mult)} AS spend, ${incomeSum(mult)} AS income, ${SPEND_COUNT} AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ?${curFilter}`,
  ).bind(f, t).first<{ spend: number; income: number; n: number }>();

  const [summary, prev, series, byCategory, byMerchant, byAccount, byEvent, byImportance] = await Promise.all([
    totals(from, to),
    totals(prevFrom, prevTo),
    // Серія: spend/income по бакетах (канонічно + зведено).
    c.env.DB.prepare(
      `SELECT strftime('${fmt}', t.time, 'unixepoch') AS bucket,
              ${spendSum(mult)} AS spend, ${incomeSum(mult)} AS income
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ?${curFilter}
       GROUP BY bucket ORDER BY bucket`,
    ).bind(from, to).all(),
    // Розбивка по ЕФЕКТИВНІЙ категорії (готівка/зняття за реальною суттю; рол-ап у батька).
    c.env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS category_id, ${EFF_CAT_NAME} AS category_name,
              ${EFF_CAT_COLOR} AS color, ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${curFilter}
       GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC`,
    ).bind(from, to).all(),
    c.env.DB.prepare(
      `SELECT t.merchant AS merchant, ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${curFilter} AND t.merchant IS NOT NULL
       GROUP BY t.merchant ORDER BY spent DESC LIMIT 10`,
    ).bind(from, to).all(),
    c.env.DB.prepare(
      `SELECT t.account_id, a.title AS account_title, a.type AS account_type, ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
       FROM transactions t ${STATS_JOINS} LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${curFilter}
       GROUP BY t.account_id ORDER BY spent DESC`,
    ).bind(from, to).all(),
    // Групи: спрощений фільтр (події можуть містити перекази); зведено в ₴.
    c.env.DB.prepare(
      `SELECT e.id AS event_id, e.name AS event_name, e.color AS event_color,
              ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
       FROM transactions t ${STATS_JOINS} JOIN event_groups e ON e.id = t.event_id
       WHERE t.time >= ? AND t.time <= ? AND ${EFF_AMOUNT} < 0 AND t.is_transfer = 0${curFilter}
       GROUP BY t.event_id ORDER BY spent DESC`,
    ).bind(from, to).all(),
    // §6 Вагомість: частка обов'язкових/бажаних/необов'язкових витрат (канонічно, зведено).
    c.env.DB.prepare(
      `SELECT ${EFF_IMPORTANCE} AS importance, ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${curFilter}
       GROUP BY ${EFF_IMPORTANCE}`,
    ).bind(from, to).all(),
  ]);

  return c.json({
    summary, prev,
    range: { from, to, prevFrom, prevTo, bucket, mode, preset: presetParam ?? null },
    series: series.results ?? [],
    byCategory: byCategory.results ?? [],
    byMerchant: byMerchant.results ?? [],
    byAccount: byAccount.results ?? [],
    byEvent: byEvent.results ?? [],
    byImportance: byImportance.results ?? [],
  });
});

// §4 Safe-to-spend: скільки вільно до кінця календарного місяця.
// = дохід(міс) − витрачено(міс) − прийдешні підписки(залишок міс). Розбивка по вагомості (§6).
api.get("/analytics/safe-to-spend", async (c) => {
  const rates = await getRates(c.env.DB);
  const { mult } = valueMode(rates, null);
  const d = new Date();
  const monthStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);

  const tot = await c.env.DB.prepare(
    `SELECT ${spendSum(mult)} AS spend, ${incomeSum(mult)} AS income,
            CAST(ROUND(COALESCE(SUM(CASE WHEN ${SPEND_WHERE} AND ${EFF_IMPORTANCE} = 'essential' THEN (-${EFF_AMOUNT}) * ${mult} ELSE 0 END), 0)) AS INTEGER) AS essential,
            CAST(ROUND(COALESCE(SUM(CASE WHEN ${SPEND_WHERE} AND t.planned_id IS NOT NULL THEN (-${EFF_AMOUNT}) * ${mult} ELSE 0 END), 0)) AS INTEGER) AS subs_paid
     FROM transactions t ${STATS_JOINS} WHERE t.time >= ? AND t.time <= ?`,
  ).bind(monthStart, now).first<{ spend: number; income: number; essential: number; subs_paid: number }>();

  // §CUR-PLAN: зводимо в ₴ по currency_code плану — інакше підписка $5 важить 5 ₴
  // і safe-to-spend завищується.
  const subs = await c.env.DB.prepare(
    `SELECT CAST(ROUND(COALESCE(SUM(period_amount * ${uahMult(rates, "currency_code")}), 0)) AS INTEGER) AS planned
     FROM planned_payments WHERE is_active = 1`,
  ).first<{ planned: number }>();

  const income = tot?.income ?? 0;
  const spend = tot?.spend ?? 0;
  const essential = tot?.essential ?? 0;
  const subsMonthly = subs?.planned ?? 0;
  const subsRemaining = Math.max(0, subsMonthly - (tot?.subs_paid ?? 0));
  const safe = income - spend - subsRemaining;
  return c.json({
    safe, income, spend, essential, discretionary: Math.max(0, spend - essential),
    subs_monthly: subsMonthly, subs_remaining: subsRemaining, month_start: monthStart,
  });
});

// Тренд капіталу: динаміка власних коштів (₴) за N місяців. Історія не зберігається,
// тож реконструюємо назад від поточного тоталу: капітал(кінець дня d) = капітал_зараз
// − Σ(зміни балансу після дня d). Кожен рядок транзакції змінює баланс рахунку на amount
// (перекази між своїми — обидві ноги в таблиці, взаємно гасяться). Курси — поточні (апрокс).
api.get("/analytics/capital-trend", async (c) => {
  const url = new URL(c.req.url);
  const months = Math.min(Math.max(Number(url.searchParams.get("months") ?? 6), 1), 24);
  const rates = await getRates(c.env.DB);
  const mult = uahMult(rates);
  const summary = await computeSummary(c.env);

  const now = Math.floor(Date.now() / 1000);
  const d = new Date();
  const fromDate = new Date(d.getFullYear(), d.getMonth() - months + 1, 1);
  const from = Math.floor(fromDate.getTime() / 1000);

  // Денна чиста зміна капіталу (₴-копійки, знак збережено) від початку періоду.
  const daily = await c.env.DB.prepare(
    `SELECT CAST(t.time / 86400 AS INTEGER) AS day,
            CAST(ROUND(COALESCE(SUM(t.amount * ${mult}), 0)) AS INTEGER) AS net
     FROM transactions t WHERE t.time >= ? GROUP BY day`,
  ).bind(from).all<{ day: number; net: number }>();
  const netByDay = new Map<number, number>();
  for (const r of daily.results ?? []) netByDay.set(r.day, r.net);

  // Йдемо від сьогодні назад: фіксуємо капітал у кінці кожного тижня.
  const todayDay = Math.floor(now / 86400);
  const fromDay = Math.floor(from / 86400);
  let running = summary.totalUAH; // капітал у кінці сьогоднішнього дня
  const points: { t: number; capital_uah: number }[] = [];
  for (let day = todayDay; day >= fromDay; day--) {
    // Точка на кінець тижня (або останній день) — щоб лінія була не надто щільною.
    if ((todayDay - day) % 7 === 0) points.push({ t: (day + 1) * 86400, capital_uah: Math.round(running / 100) });
    running -= netByDay.get(day) ?? 0; // прибираємо зміну цього дня → капітал на початок дня
  }
  points.reverse(); // хронологічно
  return c.json({ now_uah: Math.round(summary.totalUAH / 100), points });
});

/**
 * Нетворт у часі: активи (ліквідні + інвест) мінус борги, по місяцях.
 *
 * Відрізняється від `capital-trend`: той дає ОДНУ лінію нетто-капіталу. Тут потрібен
 * РОЗКЛАД, а він рахується лише поточкового: знак визначає, чи рахунок іде в подушку
 * чи в борг, тож зводити рахунки перед реконструкцією не можна. Реконструюємо кожен
 * рахунок назад окремо, а cushion/debt/investment складаємо ТИМ САМИМ правилом, що
 * `fundsBreakdown` (§R3) — інакше «зараз» на графіку не збігся б із Порадником.
 *
 * ⚠️ Дві чесні межі точності, які віддаємо клієнту в `caveats` (без них графік бреше):
 *  1) Курси — ПОТОЧНІ. Історичних не зберігаємо, тож валютний залишок минулих місяців
 *     оцінено сьогоднішнім курсом (рух курсу виглядатиме як рух грошей).
 *  2) Рахунки без історії операцій (крипта, ручні картки) назад лишаються ПЛОСКИМИ —
 *     їхній баланс це ручний зріз «на зараз», а не ряд у часі.
 */
api.get("/analytics/networth", async (c) => {
  const url = new URL(c.req.url);
  const months = Math.min(Math.max(Number(url.searchParams.get("months") ?? 12), 2), 24);
  const rates = await getRates(c.env.DB);
  const now = Math.floor(Date.now() / 1000);
  const d = new Date(now * 1000);
  const fromDate = new Date(d.getFullYear(), d.getMonth() - months + 1, 1);
  const from = Math.floor(fromDate.getTime() / 1000);

  const accounts = await c.env.DB.prepare(
    `SELECT id, title, type, role, balance, credit_limit, currency_code, is_manual
     FROM accounts WHERE is_active = 1`,
  ).all<{
    id: string; title: string | null; type: string | null; role: string | null;
    balance: number; credit_limit: number; currency_code: number; is_manual: number;
  }>();
  const accs = accounts.results ?? [];
  if (!accs.length) return c.json({ months, points: [], caveats: [], now: null });

  // Денна зміна ПО РАХУНКУ, у валюті рахунку (конвертація — на етапі зведення).
  const daily = await c.env.DB.prepare(
    `SELECT t.account_id AS acc, CAST(t.time / 86400 AS INTEGER) AS day,
            CAST(COALESCE(SUM(t.amount), 0) AS INTEGER) AS net
     FROM transactions t WHERE t.time >= ? GROUP BY t.account_id, day`,
  ).bind(from).all<{ acc: string; day: number; net: number }>();
  const netByAccDay = new Map<string, number>();
  for (const r of daily.results ?? []) netByAccDay.set(`${r.acc}:${r.day}`, r.net);

  // Поточний власний залишок кожного рахунку (баланс − кредитний ліміт, §Інваріанти).
  const own = new Map<string, number>(accs.map((a) => [a.id, (a.balance ?? 0) - (a.credit_limit ?? 0)]));
  const roleOf = (a: typeof accs[number]): "liquid" | "investment" => (a.role === "investment" ? "investment" : "liquid");
  const iso = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

  // Дати всіх майбутніх точок рахуємо ЗАЗДАЛЕГІДЬ, щоб одним запитом узяти курси на ці дати
  // (§Історія курсів). Інакше довелось би або бити по базі в циклі, або (як було) міряти
  // минулі залишки сьогоднішнім курсом.
  const todayDay = Math.floor(now / 86400);
  const fromDay = Math.floor(from / 86400);
  const pointDays: { day: number; t: number }[] = [];
  for (let day = todayDay; day >= fromDay; day--) {
    if (new Date(day * 86400 * 1000).getUTCDate() === 1 && day !== todayDay) {
      pointDays.push({ day, t: day * 86400 - 1 });
    }
  }
  const { byDay, covered } = await ratesForDays(c.env.DB, [...pointDays.map((p) => iso(p.t)), iso(now)].sort());

  // Зводимо стан рахунків у cushion/debt/investment — правило `fundsBreakdown`.
  const snapshot = (t: number, at: Rates) => {
    let cushion = 0, debt = 0, investment = 0;
    for (const a of accs) {
      const uah = toUAHMinor(own.get(a.id) ?? 0, a.currency_code, at);
      if (roleOf(a) === "investment") { if (uah > 0) investment += uah; else debt += -uah; }
      else { if (uah >= 0) cushion += uah; else debt += -uah; }
    }
    return {
      t,
      cushion: Math.round(cushion), debt: Math.round(debt), investment: Math.round(investment),
      assets: Math.round(cushion + investment),
      net: Math.round(cushion + investment - debt),
    };
  };
  const ratesAt = (t: number) => byDay.get(iso(t)) ?? rates;

  // Ідемо від сьогодні назад, знімаючи денні зміни; точку фіксуємо на кінці кожного місяця.
  const pointAtDay = new Map(pointDays.map((p) => [p.day, p.t]));
  const points: ReturnType<typeof snapshot>[] = [snapshot(now, ratesAt(now))];
  for (let day = todayDay; day >= fromDay; day--) {
    for (const a of accs) {
      const delta = netByAccDay.get(`${a.id}:${day}`);
      if (delta) own.set(a.id, (own.get(a.id) ?? 0) - delta); // назад: прибираємо зміну дня
    }
    // Кінець попереднього місяця = день, перед яким починається новий календарний місяць.
    const t = pointAtDay.get(day);
    if (t != null) points.push(snapshot(t, ratesAt(t)));
  }
  points.reverse();

  const caveats: string[] = [];
  // Кажемо про курс лише коли це справді так: коли історія покриває весь період, попередження
  // було б неправдою в інший бік — воно применшувало б точність, якої ми вже досягли.
  if (!covered) {
    caveats.push("Для частини періоду історії курсів ще нема — ті місяці перераховано поточним курсом, тож рух курсу там виглядає як рух грошей. Історія накопичується щодоби.");
  }
  const flat = accs.filter((a) => a.is_manual === 1).map((a) => a.title ?? a.type ?? a.id);
  if (flat.length) {
    caveats.push(`Рахунки без історії операцій (${flat.join(", ")}) назад показані плоскими — їхній баланс це ручний зріз «на зараз».`);
  }

  return c.json({ months, points, now: points[points.length - 1] ?? null, caveats });
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

// AI-моделі ОКРЕМО НА ЗАДАЧУ (report/advisor/insight/…): токен haiku|sonnet|opus на кожну.
// UI редагує три головні (report/advisor/insight); решта — дефолти. Enrich/OCR завжди Haiku.
const AI_MODEL_TASKS = ["report", "advisor", "insight", "chat", "budget", "group", "notify"] as const;
api.get("/settings/ai-models", async (c) => {
  const { AI_TASK_DEFAULTS, TOKEN_BY_MODEL, MODEL_BY_TOKEN } = await import("../lib/ai.ts");
  const out: Record<string, string> = {};
  for (const t of AI_MODEL_TASKS) {
    const saved = await getState(c.env.DB, `ai_model_${t}`);
    out[t] = saved && MODEL_BY_TOKEN[saved] ? saved : TOKEN_BY_MODEL[AI_TASK_DEFAULTS[t]];
  }
  return c.json({ models: out });
});
api.put("/settings/ai-models", async (c) => {
  const { MODEL_BY_TOKEN } = await import("../lib/ai.ts");
  const { task, model } = await c.req.json<{ task: string; model: string }>();
  if (!AI_MODEL_TASKS.includes(task as typeof AI_MODEL_TASKS[number]) || !MODEL_BY_TOKEN[model]) {
    return c.json({ error: "invalid task or model" }, 400);
  }
  await setState(c.env.DB, `ai_model_${task}`, model);
  return c.json({ ok: true, task, model });
});

// §P3: сторінка мерчанта — агрегати по одному мерчанту (уся історія + тренд 6 міс + частка
// в категорії). Канон stats.ts (SPEND_WHERE/amountSum/EFF_*), зведено в ₴.
api.get("/analytics/merchant", async (c) => {
  const name = new URL(c.req.url).searchParams.get("name");
  if (!name) return c.json({ error: "name required" }, 400);
  const rates = await getRates(c.env.DB);
  const { mult } = valueMode(rates, null);
  const now = Math.floor(Date.now() / 1000);
  const d = new Date(now * 1000);
  const from6 = Math.floor(new Date(d.getFullYear(), d.getMonth() - 5, 1).getTime() / 1000);

  const [agg, byMonth, topCat, txs] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ${amountSum(mult)} AS total, COUNT(DISTINCT t.id) AS n, MIN(t.time) AS first_at, MAX(t.time) AS last_at
       FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE} AND t.merchant = ?`,
    ).bind(name).first<{ total: number; n: number; first_at: number | null; last_at: number | null }>(),
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m', t.time, 'unixepoch') AS m, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE} AND t.merchant = ? AND t.time >= ?
       GROUP BY m ORDER BY m`,
    ).bind(name, from6).all<{ m: string; spent: number }>(),
    c.env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, ${EFF_CAT_NAME} AS name, ${EFF_CAT_COLOR} AS color, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE} AND t.merchant = ?
       GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC LIMIT 1`,
    ).bind(name).first<{ id: number | null; name: string | null; color: string | null; spent: number }>(),
    c.env.DB.prepare(
      `SELECT t.*, ${EFF_CAT_NAME} AS category_name, ${EFF_CAT_COLOR} AS category_color,
              COALESCE(rc.icon, c.icon) AS category_icon
       FROM transactions t ${STATS_JOINS} WHERE t.merchant = ? ORDER BY t.time DESC LIMIT 40`,
    ).bind(name).all(),
  ]);

  // Частка в категорії: витрати мерчанта / витрати всієї категорії (уся історія).
  let categoryShare: number | null = null;
  if (topCat?.id != null && topCat.spent > 0) {
    const catTot = await c.env.DB.prepare(
      `SELECT ${amountSum(mult)} AS spent FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE} AND ${EFF_CAT_ID} = ?`,
    ).bind(topCat.id).first<{ spent: number }>();
    if (catTot && catTot.spent > 0) categoryShare = Math.round((topCat.spent / catTot.spent) * 100);
  }

  const total = agg?.total ?? 0;
  const n = agg?.n ?? 0;
  return c.json({
    name,
    total, n,
    avg: n > 0 ? Math.round(total / n) : 0,
    first_at: agg?.first_at ?? null,
    last_at: agg?.last_at ?? null,
    by_month: (byMonth.results ?? []).map((r) => ({ month: r.m, spent: r.spent })),
    top_category: topCat?.name ? { name: topCat.name, color: topCat.color, spent: topCat.spent } : null,
    category_share: categoryShare,
    transactions: txs.results ?? [],
  });
});

// Порівняння двох періодів side-by-side (беклог): вибраний період A проти попереднього
// рівного за довжиною B. Тотали + розбивка по категоріях (рол-ап підкатегорій), per-currency.
api.get("/analytics/compare", async (c) => {
  const url = new URL(c.req.url);
  const rates = await getRates(c.env.DB);
  const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(url.searchParams.get("from") ?? to - 30 * 86400);
  const span = to - from;
  const cur = url.searchParams.get("currency") ? Number(url.searchParams.get("currency")) : null;
  const { mult, curFilter } = valueMode(rates, cur);
  // §D: фронт може передати явні межі попереднього періоду; інакше рівний відрізок перед.
  const bpFrom = url.searchParams.get("bfrom");
  const bpTo = url.searchParams.get("bto");
  const bFrom = bpFrom != null ? Number(bpFrom) : from - span;
  const bTo = bpTo != null ? Number(bpTo) : from;

  const totals = (f: number, t: number) => c.env.DB.prepare(
    `SELECT ${spendSum(mult)} AS spend, ${incomeSum(mult)} AS income
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ?${curFilter}`,
  ).bind(f, t).first<{ spend: number; income: number }>();

  const cats = (f: number, t: number) => c.env.DB.prepare(
    `SELECT ${EFF_CAT_ID} AS category_id, ${EFF_CAT_NAME} AS category_name, ${EFF_CAT_COLOR} AS color,
            ${amountSum(mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}${curFilter}
     GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC`,
  ).bind(f, t).all();

  const [aTot, bTot, aCats, bCats] = await Promise.all([totals(from, to), totals(bFrom, bTo), cats(from, to), cats(bFrom, bTo)]);
  return c.json({
    a: { from, to, spend: aTot?.spend ?? 0, income: aTot?.income ?? 0, byCategory: aCats.results ?? [] },
    b: { from: bFrom, to: bTo, spend: bTot?.spend ?? 0, income: bTot?.income ?? 0, byCategory: bCats.results ?? [] },
  });
});

// Month-end forecast (§7): project this month's spend from the current daily pace
// plus known upcoming planned payments. UAH only, transfers excluded. No migration.
api.get("/analytics/forecast", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const d = new Date(now * 1000);
  const monthStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const dayOfMonth = d.getDate(); // 1..daysInMonth
  const daysElapsed = dayOfMonth;
  const daysRemaining = daysInMonth - dayOfMonth;

  const rates = await getRates(c.env.DB);
  const { mult } = valueMode(rates, null); // forecast завжди зведено в ₴
  // Трейлінг: до 3 ПОВНИХ місяців перед поточним — для історичного якоря прогнозу.
  const trailStart = Math.floor(new Date(d.getFullYear(), d.getMonth() - 3, 1).getTime() / 1000);
  const [totals, trail] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ${spendSum(mult)} AS spend, ${incomeSum(mult)} AS income
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ?`,
    ).bind(monthStart, now).first<{ spend: number; income: number }>(),
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m', t.time, 'unixepoch') AS m, ${spendSum(mult)} AS spend
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time < ? GROUP BY m`,
    ).bind(trailStart, monthStart).all<{ m: string; spend: number }>(),
  ]);

  const spend = totals?.spend ?? 0;
  const income = totals?.income ?? 0;
  const pace = daysElapsed > 0 ? spend / daysElapsed : 0;
  // Прогноз місяця = блендимо наївний темп (роздуває рано в місяці) з історичним якорем
  // (факт + середньомісячна історія на дні, що лишились). Рано довіряємо історії, під кінець —
  // фактичному темпу. Без історії — падаємо на чистий темп.
  const trailMonths = (trail.results ?? []).map((r) => r.spend);
  const avgMonth = trailMonths.length ? trailMonths.reduce((s, v) => s + v, 0) / trailMonths.length : 0;
  const elapsedFrac = Math.min(1, Math.max(0.05, daysElapsed / daysInMonth));
  const paceProj = pace * daysInMonth;
  const histProj = spend + avgMonth * (daysRemaining / daysInMonth);
  const projectedSpend = avgMonth > 0
    ? Math.round(paceProj * elapsedFrac + histProj * (1 - elapsedFrac))
    : Math.round(paceProj);

  // Діапазон довіри: розкид (σ) місячних витрат історії, звужений на решту місяця (вже витрачене
  // — певне). Дає чесніший «12–15к» замість однієї цифри. Без історії — діапазон = точка.
  const sd = trailMonths.length > 1
    ? Math.sqrt(trailMonths.reduce((s, v) => s + (v - avgMonth) ** 2, 0) / trailMonths.length)
    : avgMonth * 0.15;
  const band = avgMonth > 0 ? Math.round(sd * (daysRemaining / daysInMonth) * 0.9) : 0;
  const projectedLow = Math.max(spend, projectedSpend - band);
  const projectedHigh = projectedSpend + band;

  // Майбутні планові платежі, що спишуться до кінця місяця (інформативно).
  const { nextChargeUnix, plannedUAH } = await import("../lib/subscriptions.ts");
  const fxRates = await getRates(c.env.DB);
  const planned = await c.env.DB.prepare(
    "SELECT id, title, kind, period_amount, currency_code, period, period_count, start_date, end_date FROM planned_payments WHERE is_active = 1",
  ).all<{ id: number; title: string; kind: string; period_amount: number | null; currency_code: number | null; period: string; period_count: number | null; start_date: number; end_date: number | null }>();

  // §CUR-PLAN: суми зводимо в ₴ — вони йдуть в один ряд із витратами місяця (теж ₴).
  const monthEnd = Math.floor(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() / 1000);
  const upcomingItems = (planned.results ?? [])
    .filter((p) => !(p.kind === "installment" && p.end_date != null && p.end_date <= now))
    .map((p) => ({
      title: p.title,
      amount: plannedUAH(p.period_amount, p.currency_code, fxRates),
      at: nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, now),
    }))
    .filter((p) => p.amount > 0 && p.at < monthEnd)
    .sort((a, b) => a.at - b.at);
  const upcomingPlanned = upcomingItems.reduce((s, p) => s + p.amount, 0);

  return c.json({
    monthStart, now, daysInMonth, daysElapsed, daysRemaining,
    spend, income, pace: Math.round(pace),
    projectedSpend, projectedLow, projectedHigh, projectedNet: income - projectedSpend,
    upcomingPlanned, upcomingItems,
  });
});

// §1 Аналітика доходу: джерела (по ефективній категорії за період), стабільність
// (варіативність місячного доходу за 6 повних місяців) і дельта проти минулого періоду.
// Канонічно (INCOME_WHERE), зведено в ₴. Дзеркалить визначення Статистики.
api.get("/analytics/income", async (c) => {
  const url = new URL(c.req.url);
  const rates = await getRates(c.env.DB);
  const mode = ((await getState(c.env.DB, "period_mode")) as PeriodMode) || "calendar";
  const presetParam = (url.searchParams.get("preset") as Preset | null) ?? "month";
  const preset: Preset = ["week", "month", "quarter", "year"].includes(presetParam) ? presetParam : "month";
  const { from, to, prevFrom, prevTo } = periodBounds(mode, preset);
  const cur = url.searchParams.get("currency") ? Number(url.searchParams.get("currency")) : null;
  const { mult, curFilter } = valueMode(rates, cur);

  // Сума доходу по рядках (INCOME_WHERE уже у WHERE) — додатна, зведена.
  const incSum = `CAST(ROUND(COALESCE(SUM(t.amount * ${mult}), 0)) AS INTEGER)`;

  const [sources, curTot, prevTot, monthly] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS category_id, ${EFF_CAT_NAME} AS name, ${EFF_CAT_COLOR} AS color,
              ${incSum} AS amount, COUNT(*) AS n
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${INCOME_WHERE}${curFilter}
       GROUP BY ${EFF_CAT_ID} ORDER BY amount DESC`,
    ).bind(from, to).all<{ category_id: number | null; name: string | null; color: string | null; amount: number; n: number }>(),
    c.env.DB.prepare(
      `SELECT ${incomeSum(mult)} AS income FROM transactions t ${STATS_JOINS} WHERE t.time >= ? AND t.time <= ?${curFilter}`,
    ).bind(from, to).first<{ income: number }>(),
    c.env.DB.prepare(
      `SELECT ${incomeSum(mult)} AS income FROM transactions t ${STATS_JOINS} WHERE t.time >= ? AND t.time <= ?${curFilter}`,
    ).bind(prevFrom, prevTo).first<{ income: number }>(),
    // 6 календарних місяців для оцінки стабільності (по місяцях).
    (async () => {
      const now = new Date();
      const mFrom = Math.floor(new Date(now.getFullYear(), now.getMonth() - 5, 1).getTime() / 1000);
      const nowS = Math.floor(Date.now() / 1000);
      return c.env.DB.prepare(
        `SELECT strftime('%Y-%m', t.time, 'unixepoch') AS m, ${incomeSum(mult)} AS income
         FROM transactions t ${STATS_JOINS} WHERE t.time >= ? AND t.time <= ?${curFilter} GROUP BY m ORDER BY m`,
      ).bind(mFrom, nowS).all<{ m: string; income: number }>();
    })(),
  ]);

  const total = curTot?.income ?? 0;
  const prevTotal = prevTot?.income ?? 0;
  const deltaPct = prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 100) : (total > 0 ? null : 0);

  const srcRows = (sources.results ?? []).map((s) => ({
    category_id: s.category_id, name: s.name ?? "Інше", color: s.color,
    amount: s.amount, n: s.n, pct: total > 0 ? Math.round((s.amount / total) * 100) : 0,
  }));

  // Стабільність: коеф. варіації (stddev/mean) по ПОВНИХ місяцях (без поточного часткового).
  const nowMonth = new Date().toISOString().slice(0, 7);
  const complete = (monthly.results ?? []).filter((r) => r.m !== nowMonth).map((r) => r.income);
  let cvPct: number | null = null, label = "мало даних";
  if (complete.length >= 2) {
    const mean = complete.reduce((a, b) => a + b, 0) / complete.length;
    if (mean > 0) {
      const variance = complete.reduce((a, b) => a + (b - mean) ** 2, 0) / complete.length;
      cvPct = Math.round((Math.sqrt(variance) / mean) * 100);
      label = cvPct <= 15 ? "стабільний" : cvPct <= 40 ? "помірний" : "нестабільний";
    }
  }

  return c.json({
    period: { from, to, preset },
    total, prev_total: prevTotal, delta_pct: deltaPct,
    sources: srcRows,
    monthly: (monthly.results ?? []).map((r) => ({ month: r.m, income: r.income })),
    stability: { cv_pct: cvPct, label },
  });
});

// §4 Прийдешні планові списання (підписки/розстрочки) у горизонті N днів — для віджета
// «скоро спишеться» на Головній. Перетинає межу місяця (на відміну від forecast).
api.get("/planned/upcoming", async (c) => {
  const url = new URL(c.req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30), 1), 90);
  const now = Math.floor(Date.now() / 1000);
  const horizon = now + days * 86400;

  const { nextChargeUnix, plannedUAH } = await import("../lib/subscriptions.ts");
  const rates = await getRates(c.env.DB);
  const planned = await c.env.DB.prepare(
    "SELECT id, title, kind, period_amount, currency_code, period, period_count, start_date, end_date, category_id FROM planned_payments WHERE is_active = 1",
  ).all<{ id: number; title: string; kind: string; period_amount: number | null; currency_code: number | null; period: string; period_count: number | null; start_date: number; end_date: number | null; category_id: number | null }>();

  // §CUR-PLAN: `amount` лишається у ВАЛЮТІ ПЛАНУ (щоб показати «$5», а не «≈208 ₴»),
  // `amount_uah` — зведення для підсумків. Раніше валюта губилась і $5 ставало 5 ₴.
  const items = (planned.results ?? [])
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

// Cashflow-календар: ВСІ очікувані списання (підписки/розстрочки) по днях у вікні [from,to]
// (на відміну від /planned/upcoming — той дає лише наступне списання на план). + стартова
// ліквідна подушка для проєкції балансу «наперед» → видно провали ліквідності. Аутфлоу-only
// (планового доходу в моделі нема; регулярна зарплата — майбутнє покращення).
api.get("/analytics/cashflow-calendar", async (c) => {
  const url = new URL(c.req.url);
  const now = Math.floor(Date.now() / 1000);
  const nd = new Date(now * 1000);
  const defFrom = Math.floor(new Date(nd.getFullYear(), nd.getMonth(), 1).getTime() / 1000);
  const defTo = Math.floor(new Date(nd.getFullYear(), nd.getMonth() + 2, 0, 23, 59, 59).getTime() / 1000);
  const from = Number(url.searchParams.get("from") ?? defFrom);
  const to = Number(url.searchParams.get("to") ?? defTo);

  const { nextChargeUnix, plannedUAH } = await import("../lib/subscriptions.ts");
  const { fundsBreakdown } = await import("../lib/advisor.ts");
  const [planned, funds, rates] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, title, kind, period_amount, currency_code, period, period_count, start_date, end_date, category_id FROM planned_payments WHERE is_active = 1",
    ).all<{ id: number; title: string; kind: string; period_amount: number | null; currency_code: number | null; period: string; period_count: number | null; start_date: number; end_date: number | null; category_id: number | null }>(),
    fundsBreakdown(c.env),
    getRates(c.env.DB),
  ]);

  const iso = (u: number) => new Date(u * 1000).toISOString().slice(0, 10);
  // §CUR-PLAN: `amount` — у ₴, бо його сумують по днях і віднімають від подушки (теж ₴).
  // Оригінал лишаємо в `amount_orig`/`currency_code`, щоб UI показав «$5» поряд.
  const items: { at: number; date: string; title: string; amount: number; amount_orig: number; currency_code: number; category_id: number | null; kind: string }[] = [];
  for (const p of planned.results ?? []) {
    const amt = p.period_amount ?? 0;
    if (amt <= 0) continue;
    const uah = plannedUAH(amt, p.currency_code, rates);
    let t = nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, from - 1);
    for (let guard = 0; guard < 400 && t <= to; guard++) {
      if (p.end_date != null && t > p.end_date) break; // розстрочка добігла кінця
      items.push({ at: t, date: iso(t), title: p.title, amount: uah, amount_orig: amt, currency_code: p.currency_code ?? 980, category_id: p.category_id, kind: p.kind });
      t = nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, t);
    }
  }
  items.sort((a, b) => a.at - b.at);
  return c.json({ from, to, now, cushion: funds.cushion, items });
});

// Аналітика позицій чека (receipt_items з OCR): топ товарів за сумою за період.
// price — копійки за рядок; групуємо за нормалізованою назвою. Показуємо, лише якщо є чеки.
api.get("/analytics/receipt-items", async (c) => {
  const url = new URL(c.req.url);
  const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(url.searchParams.get("from") ?? to - 90 * 86400);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 15), 1), 50);

  // Дата позиції = purchased_at чека (fallback created_at). Тільки чеки в періоді.
  const rows = await c.env.DB.prepare(
    `SELECT LOWER(TRIM(ri.name)) AS name, CAST(COALESCE(SUM(ri.price), 0) AS INTEGER) AS total,
            ROUND(COALESCE(SUM(COALESCE(ri.qty, 1)), 0), 2) AS qty, COUNT(*) AS n
     FROM receipt_items ri
     JOIN receipts r ON r.id = ri.receipt_id
     WHERE ri.name IS NOT NULL AND ri.name <> '' AND ri.price > 0
       AND COALESCE(r.purchased_at, r.created_at) >= ? AND COALESCE(r.purchased_at, r.created_at) <= ?
     GROUP BY LOWER(TRIM(ri.name)) ORDER BY total DESC LIMIT ?`,
  ).bind(from, to, limit).all<{ name: string; total: number; qty: number; n: number }>();

  const meta = await c.env.DB.prepare(
    `SELECT COUNT(*) AS receipts, COALESCE(SUM(cnt), 0) AS items FROM (
       SELECT r.id, COUNT(ri.id) AS cnt FROM receipts r JOIN receipt_items ri ON ri.receipt_id = r.id
       WHERE COALESCE(r.purchased_at, r.created_at) >= ? AND COALESCE(r.purchased_at, r.created_at) <= ?
       GROUP BY r.id)`,
  ).bind(from, to).first<{ receipts: number; items: number }>();

  return c.json({ items: rows.results ?? [], receipts: meta?.receipts ?? 0, total_items: meta?.items ?? 0 });
});

// §E4: дрейф цін / персональна інфляція. Для кожної позиції чека (нормалізована назва)
// беремо ЮНІТ-ціну (price/qty) в кожній покупці; якщо позиція трапилась ≥3 разів із
// достатнім розкидом у часі — порівнюємо середню юніт-ціну ранньої половини покупок із
// пізньою → % зміни. Індекс кошика = медіана змін по позиціях. Детерміновано, без AI.
api.get("/analytics/price-drift", async (c) => {
  const url = new URL(c.req.url);
  const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(url.searchParams.get("from") ?? to - 180 * 86400);
  const MIN_N = 3, MIN_SPAN = 21 * 86400, NOISE = 5;

  const rows = await c.env.DB.prepare(
    `SELECT LOWER(TRIM(ri.name)) AS name, COALESCE(r.purchased_at, r.created_at) AS at,
            ri.price AS price, COALESCE(ri.qty, 1) AS qty
     FROM receipt_items ri JOIN receipts r ON r.id = ri.receipt_id
     WHERE ri.name IS NOT NULL AND ri.name <> '' AND ri.price > 0 AND COALESCE(ri.qty, 1) > 0
       AND COALESCE(r.purchased_at, r.created_at) >= ? AND COALESCE(r.purchased_at, r.created_at) <= ?
     ORDER BY at ASC`,
  ).bind(from, to).all<{ name: string; at: number; price: number; qty: number }>();

  const byName = new Map<string, { at: number; unit: number }[]>();
  for (const r of rows.results ?? []) {
    const unit = r.price / r.qty;
    (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)!).push({ at: r.at, unit });
  }

  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const items: { name: string; first_unit: number; last_unit: number; change_pct: number; n: number; first_at: number; last_at: number }[] = [];
  for (const [name, occ] of byName) {
    if (occ.length < MIN_N) continue;
    const span = occ[occ.length - 1].at - occ[0].at;
    if (span < MIN_SPAN) continue;
    const half = Math.ceil(occ.length / 2);
    const early = mean(occ.slice(0, half).map((o) => o.unit));
    const late = mean(occ.slice(half).map((o) => o.unit));
    if (early <= 0) continue;
    const change = ((late - early) / early) * 100;
    items.push({
      name, first_unit: Math.round(early), last_unit: Math.round(occ[occ.length - 1].unit),
      change_pct: Math.round(change * 10) / 10, n: occ.length, first_at: occ[0].at, last_at: occ[occ.length - 1].at,
    });
  }

  // Індекс кошика — медіана змін (стійка до викидів).
  const changes = items.map((i) => i.change_pct).sort((a, b) => a - b);
  const basket = changes.length ? (changes.length % 2 ? changes[(changes.length - 1) / 2] : (changes[changes.length / 2 - 1] + changes[changes.length / 2]) / 2) : null;

  // Топ рухів (лишаємо лише помітні), за модулем зміни.
  const movers = items.filter((i) => Math.abs(i.change_pct) >= NOISE).sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct)).slice(0, 12);

  return c.json({ window: { from, to }, basket_change_pct: basket != null ? Math.round(basket * 10) / 10 : null, tracked: items.length, items: movers });
});

// §E1/E2/E3: патерни витрат ЦЬОГО МІСЯЦЯ — усе детерміновано, без AI.
//  • recurring: разові vs регулярні (канон stats.ts) + топ разових;
//  • anomalies: категорії, чий прогноз на кінець місяця значно вищий за звичний (трейлінг 6 міс);
//  • pace: темп по топ-категоріях — факт (MTD) vs звичний місяць vs лінійний прогноз.
api.get("/analytics/patterns", async (c) => {
  const rates = await getRates(c.env.DB);
  const { mult } = valueMode(rates, null);
  const now = Math.floor(Date.now() / 1000);
  const d = new Date(now * 1000);
  const monthStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
  const nextMonthStart = Math.floor(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() / 1000);
  const elapsedFrac = Math.min(1, Math.max(0.02, (now - monthStart) / (nextMonthStart - monthStart)));
  const curKey = new Date(now * 1000).toISOString().slice(0, 7);
  // Трейлінг-вікно: 6 повних місяців перед поточним.
  const refStart = Math.floor(new Date(d.getFullYear(), d.getMonth() - 6, 1).getTime() / 1000);
  const trailingKeys: string[] = [];
  for (let i = 6; i >= 1; i--) trailingKeys.push(new Date(d.getFullYear(), d.getMonth() - i, 1).toISOString().slice(0, 7));

  const recurExpr = isRecurringExpr(defaultRefFrom(now), now);
  const levels = await categoryMonthlyLevels(c.env, mult, { now }); // канонічний «місячний рівень»
  const [matrix, split, curSplit] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, ${EFF_CAT_NAME} AS name, ${EFF_CAT_COLOR} AS color,
              strftime('%Y-%m', t.time, 'unixepoch') AS m, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
       GROUP BY ${EFF_CAT_ID}, m`,
    ).bind(refStart, now).all<{ id: number | null; name: string | null; color: string | null; m: string; spent: number }>(),
    recurringOneoffSplit(c.env, monthStart, now, mult, defaultRefFrom(now)),
    // Поточний місяць по категоріях, розділений на регулярне/разове + сигнали лумпності
    // (n — к-ть операцій, biggest — найбільша одна) для чесного прогнозу.
    c.env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id,
              CAST(ROUND(COALESCE(SUM(CASE WHEN ${recurExpr} THEN (-${EFF_AMOUNT}) * ${mult} ELSE 0 END), 0)) AS INTEGER) AS recurring,
              CAST(ROUND(COALESCE(SUM(CASE WHEN ${recurExpr} THEN 0 ELSE (-${EFF_AMOUNT}) * ${mult} END), 0)) AS INTEGER) AS oneoff,
              COUNT(DISTINCT t.id) AS n,
              CAST(ROUND(COALESCE(MAX((-${EFF_AMOUNT}) * ${mult}), 0)) AS INTEGER) AS biggest
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
       GROUP BY ${EFF_CAT_ID}`,
    ).bind(monthStart, now).all<{ id: number | null; recurring: number; oneoff: number; n: number; biggest: number }>(),
  ]);
  const curSplitMap = new Map<string, { recurring: number; oneoff: number; n: number; biggest: number }>();
  for (const r of curSplit.results ?? []) curSplitMap.set(String(r.id ?? "null"), { recurring: r.recurring, oneoff: r.oneoff, n: r.n, biggest: r.biggest });

  interface Cat { id: number | null; name: string; color: string | null; months: Map<string, number> }
  const cats = new Map<string, Cat>();
  for (const r of matrix.results ?? []) {
    const key = String(r.id ?? "null");
    let cat = cats.get(key);
    if (!cat) { cat = { id: r.id, name: r.name ?? "без категорії", color: r.color, months: new Map() }; cats.set(key, cat); }
    cat.months.set(r.m, r.spent);
  }

  const MIN_DELTA = 20000; // 200₴ — нижче не шумимо
  interface PaceItem { category: string; color: string | null; spent: number; oneoff: number; mostly_oneoff: boolean; lumpy: boolean; projected: number; usual: number; pct: number | null }
  const anomalies: PaceItem[] = [];
  const pace: PaceItem[] = [];
  for (const cat of cats.values()) {
    const cur = cat.months.get(curKey) ?? 0;
    const trailing = trailingKeys.map((k) => cat.months.get(k) ?? 0);
    const cs = curSplitMap.get(String(cat.id ?? "null")) ?? { recurring: cur, oneoff: 0, n: 0, biggest: cur };
    const mostlyOneoff = cs.oneoff > cs.recurring;
    // «Звичний місячний рівень» — з ЄДИНОГО канонічного джерела (stats.categoryMonthlyLevels):
    // fixed-кости (рента/підписка) = останній платіж (ловить стрибок), змінні = середнє.
    const lv = cat.id != null ? levels.get(cat.id) : undefined;
    const usual = lv?.level ?? Math.round(trailing.reduce((s, v) => s + v, 0) / trailingKeys.length);
    // Лумп для ПРОЄКЦІЇ поточного місяця: цьогомісячна витрата в 1-2 великих операціях (податок/
    // заправка) АБО fixed-кост, ще не сплачений цього місяця (рента) — не екстраполюємо по днях.
    const lumpy = (cur > 0 && (cs.n <= 1 || cs.biggest >= cur * 0.55)) || (cur === 0 && !!lv?.fixed);
    // Прогноз зі здоровим глуздом (stats.projectSpend): факт + історичний залишок; лумпи
    // не екстраполюємо; кеп 3× звичного. Прибирає «2500 на транспорт» / «10к податків».
    const projected = projectSpend(cur, usual, elapsedFrac, lumpy);
    const item: PaceItem = { category: cat.name, color: cat.color, spent: cur, oneoff: cs.oneoff, mostly_oneoff: mostlyOneoff, lumpy, projected, usual, pct: usual > 0 ? Math.round((projected / usual) * 100) : null };
    if (cur > 0 || usual > 0) pace.push(item);
    // Аномалія темпу: прогноз ≥1.5× звичного і різниця вагома. Не флагуємо разові/лумпи —
    // вони вже сталися (це не «розганяється темп», а разовий факт).
    if (cur > 0 && !mostlyOneoff && !lumpy && projected >= usual * 1.5 && projected - usual >= MIN_DELTA) {
      anomalies.push(item);
    }
  }
  anomalies.sort((a, b) => (b.projected - b.usual) - (a.projected - a.usual));
  pace.sort((a, b) => b.projected - a.projected);

  return c.json({
    period: { from: monthStart, to: now, elapsed_frac: Math.round(elapsedFrac * 100) / 100 },
    recurring: split,
    anomalies: anomalies.slice(0, 6),
    pace: pace.slice(0, 8),
  });
});

// Drill-down однієї (батьківської) категорії за період: розбивка по підкатегоріях +
// топ-мерчанти всередині. Для «відкрити велику категорію й глянути детальніше» (§F5).
api.get("/analytics/category", async (c) => {
  const url = new URL(c.req.url);
  const parent = Number(url.searchParams.get("category"));
  const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(url.searchParams.get("from") ?? to - 30 * 86400);
  const rates = await getRates(c.env.DB);
  const cur = url.searchParams.get("currency") ? Number(url.searchParams.get("currency")) : null;
  const { mult, curFilter } = valueMode(rates, cur);

  const TRANSFER_CAT = 13;
  if (parent === TRANSFER_CAT) {
    // Спец-бакет «Перекази і зняття»: незакриті рухи (готівка/зняття без реальної категорії)
    // + справжні перекази. Інформативно, ПОЗА канонічними витратами. Групуємо за реальною суттю.
    const base = "t.time >= ? AND t.time <= ? AND t.amount < 0 AND t.hold = 0 AND COALESCE(c.parent_id, t.category_id) = 13" + curFilter;
    const [subs, merchants, txs] = await Promise.all([
      c.env.DB.prepare(
        `SELECT t.real_category_id AS category_id, COALESCE(rc.name, 'не визначено') AS name, rc.color AS color,
                ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
         FROM transactions t ${STATS_JOINS}
         WHERE ${base} GROUP BY t.real_category_id ORDER BY spent DESC`,
      ).bind(from, to).all(),
      c.env.DB.prepare(
        `SELECT t.merchant AS merchant, ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
         FROM transactions t ${STATS_JOINS}
         WHERE ${base} AND t.merchant IS NOT NULL AND t.merchant <> '' GROUP BY t.merchant ORDER BY spent DESC LIMIT 12`,
      ).bind(from, to).all(),
      c.env.DB.prepare(
        `SELECT t.id, t.time, t.amount, t.currency_code, t.merchant, t.comment,
                rc.name AS category_name, rc.color AS category_color
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
                              LEFT JOIN categories rc ON rc.id = t.real_category_id
         WHERE ${base} ORDER BY t.amount ASC LIMIT 60`,
      ).bind(from, to).all(),
    ]);
    return c.json({ subs: subs.results ?? [], merchants: merchants.results ?? [], transactions: txs.results ?? [] });
  }

  // Звичайна категорія: канонічні витрати, де ЕФЕКТИВНА категорія (рол-ап) = parent.
  // Розбивка — по фактичній листовій категорії (реальна для готівки, інакше звичайна).
  const base = `t.time >= ? AND t.time <= ? AND ${SPEND_WHERE} AND ${EFF_CAT_ID} = ?${curFilter}`;
  const [subs, merchants, txs] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COALESCE(rc.id, c.id) AS category_id, COALESCE(rc.name, c.name, 'без категорії') AS name,
              COALESCE(rc.color, c.color) AS color, ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
       FROM transactions t ${STATS_JOINS}
       WHERE ${base} GROUP BY COALESCE(rc.id, c.id) ORDER BY spent DESC`,
    ).bind(from, to, parent).all(),
    c.env.DB.prepare(
      `SELECT t.merchant AS merchant, ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
       FROM transactions t ${STATS_JOINS}
       WHERE ${base} AND t.merchant IS NOT NULL AND t.merchant <> '' GROUP BY t.merchant ORDER BY spent DESC LIMIT 12`,
    ).bind(from, to, parent).all(),
    c.env.DB.prepare(
      `SELECT t.id, t.time, t.amount, t.currency_code, t.merchant, t.comment,
              COALESCE(rc.name, c.name) AS category_name, COALESCE(rc.color, c.color) AS category_color
       FROM transactions t ${STATS_JOINS}
       WHERE ${base} ORDER BY t.amount ASC LIMIT 60`,
    ).bind(from, to, parent).all(),
  ]);
  return c.json({ subs: subs.results ?? [], merchants: merchants.results ?? [], transactions: txs.results ?? [] });
});

// §R2-ST5(б): drill будь-якого зрізу (мерчант / картка / група) — підсумок + самі
// операції з переходом на /tx/:id. dim = merchant | account | event.
api.get("/analytics/slice", async (c) => {
  const url = new URL(c.req.url);
  const dim = url.searchParams.get("dim") ?? "merchant"; // merchant|account|event|weekday|day|all
  const type = url.searchParams.get("type") === "income" ? "income" : "expense";
  const value = url.searchParams.get("value") ?? "";
  const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(url.searchParams.get("from") ?? to - 30 * 86400);
  const rates = await getRates(c.env.DB);
  const cur = url.searchParams.get("currency") ? Number(url.searchParams.get("currency")) : null;
  const { mult, curFilter } = valueMode(rates, cur);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 300);

  // Канонічний фільтр за типом (щоб сума зрізу узгоджувалась із KPI Огляду).
  const canon = type === "income" ? INCOME_WHERE : SPEND_WHERE;
  // §E1: dim=weekday — 0=нд..6=сб. dim=day — конкретна календарна дата (той самий UTC-бакет,
  // яким рахувались series). dim=all — увесь період (для дрилу «Витрати/Надходження»).
  const dimCol = dim === "account" ? "t.account_id"
    : dim === "event" ? "t.event_id"
    : dim === "weekday" ? "CAST(strftime('%w', t.time, 'unixepoch') AS INTEGER)"
    : dim === "day" ? "strftime('%Y-%m-%d', t.time, 'unixepoch')"
    : dim === "dom" ? "CAST(strftime('%d', t.time, 'unixepoch') AS INTEGER)" // §1: число місяця (heat-map)
    : dim === "importance" ? EFF_IMPORTANCE // §6: вагомість ефективної категорії/override
    : dim === "all" ? null
    : "t.merchant";
  const dimClause = dimCol ? ` AND ${dimCol} = ?` : "";
  const base = `t.time >= ? AND t.time <= ? AND ${canon}${curFilter}${dimClause}`;
  const binds: unknown[] = dimCol
    ? [from, to, dim === "event" || dim === "weekday" || dim === "dom" ? Number(value) : value]
    : [from, to];
  const order = type === "income" ? "DESC" : "ASC"; // найбільша витрата / найбільше надходження зверху

  const [summary, txs] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
       FROM transactions t ${STATS_JOINS} WHERE ${base}`,
    ).bind(...binds).first<{ spent: number; n: number }>(),
    c.env.DB.prepare(
      `SELECT t.id, t.time, t.amount, t.currency_code, t.merchant, t.comment, t.user_note,
              ${EFF_CAT_NAME} AS category_name, ${EFF_CAT_COLOR} AS category_color
       FROM transactions t ${STATS_JOINS}
       WHERE ${base} ORDER BY t.amount ${order} LIMIT ?`,
    ).bind(...binds, limit).all(),
  ]);
  // Для доходу сума виходить від'ємною (amountSum рахує -amount) — віддаємо абсолют.
  const spent = Math.abs(summary?.spent ?? 0);
  return c.json({ spent, n: summary?.n ?? 0, transactions: txs.results ?? [] });
});

// Which currencies actually have transactions (for the stats currency switch).
api.get("/analytics/currencies", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT DISTINCT currency_code FROM transactions ORDER BY currency_code",
  ).all<{ currency_code: number }>();
  return c.json((rows.results ?? []).map((r) => r.currency_code));
});

// Spend by effective category for a period, зведено в ₴ (канонічно).
api.get("/analytics/by-category", async (c) => {
  const url = new URL(c.req.url);
  const from = Number(url.searchParams.get("from") ?? 0);
  const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
  const rates = await getRates(c.env.DB);
  const { mult } = valueMode(rates, null);
  const rows = await c.env.DB.prepare(
    `SELECT ${EFF_CAT_ID} AS category_id, ${EFF_CAT_NAME} AS category_name, ${EFF_CAT_COLOR} AS color,
            ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
     GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC`,
  ).bind(from, to).all();
  return c.json(rows.results);
});

// ---- AI enrichment (hybrid) -------------------------------------------------

// Enrich one transaction on demand (manual "AI: що це?").
api.post("/transactions/:id/enrich", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const { enrichOne } = await import("../lib/enrich.ts");
  try {
    const ok = await enrichOne(c.env, c.req.param("id"), { force: true });
    return c.json(ok ? { ok: true } : { error: "not_found" }, ok ? 200 : 404);
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// Bulk-enrich uncategorised transactions, a small batch per call (client loops).
api.post("/enrich/pending", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const { enrichPending } = await import("../lib/enrich.ts");
  try {
    return c.json(await enrichPending(c.env));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

api.get("/enrich/status", async (c) => {
  const r = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE source = 'mono' AND ai_enriched = 0 AND category_id IS NULL AND hold = 0",
  ).first<{ n: number }>();
  return c.json({ pending: r?.n ?? 0 });
});

// Detect internal transfers between own accounts (opposite equal amounts, ±15 min).
api.post("/transfers/detect", async (c) => {
  const { detectTransfers } = await import("../lib/transfers.ts");
  const marked = await detectTransfers(c.env);
  return c.json({ ok: true, marked });
});

// §F2 крок 2: AI-розмітка реальної категорії для операцій у бакеті «Перекази і зняття».
// Малий батч за виклик, клієнт повторює поки remaining > 0. Навчене застосовується без AI.
api.post("/transfers/categorize", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const { categorizeTransfers } = await import("../lib/enrich.ts");
  try {
    return c.json(await categorizeTransfers(c.env));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// Скільки переказів/знять ще без реальної категорії (для стану кнопки).
api.get("/transfers/status", async (c) => {
  const { transfersPending } = await import("../lib/enrich.ts");
  return c.json({ pending: await transfersPending(c.env) });
});

// §R2-ST4: рев'ю. Проганяє AI по батчу нерозмічених переказів і повертає пропозиції
// (зі збереженням у БД) для перегляду/правки. needs_attention = AI не впевнений/не визначив.
api.post("/transfers/review", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const { reviewTransfers } = await import("../lib/enrich.ts");
  const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? 12);
  try {
    return c.json(await reviewTransfers(c.env, limit));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §C2: перепрогнати ОДИН переказ через AI з підказкою користувача («описати для AI»).
api.post("/transfers/review/one", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const b = await c.req.json<{ id?: string; hint?: string }>();
  if (!b.id || !b.hint?.trim()) return c.json({ error: "id and hint required" }, 400);
  const { reviewTransferWithHint } = await import("../lib/enrich.ts");
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
    await c.env.DB.prepare("UPDATE transactions SET real_category_id = ? WHERE id = ?")
      .bind(it.real_category_id, it.id).run();
    if (it.learn) {
      const tx = await c.env.DB.prepare("SELECT source, raw_json FROM transactions WHERE id = ?")
        .bind(it.id).first<{ source: string; raw_json: string | null }>();
      const rawKey = tx?.raw_json ? (JSON.parse(tx.raw_json) as { description?: string }).description?.trim() : null;
      if (tx?.source === "mono" && rawKey) {
        // Прив'язуємо реальну категорію до alias по сирому опису + застосовуємо до схожих.
        const upd = await c.env.DB.prepare(
          "UPDATE merchant_aliases SET real_category_id = ? WHERE match_type = 'mono_desc' AND raw_key = ?",
        ).bind(it.real_category_id, rawKey).run();
        if (!upd.meta.changes) {
          await c.env.DB.prepare(
            `INSERT INTO merchant_aliases (match_type, raw_key, real_category_id, created_at) VALUES ('mono_desc', ?, ?, ?)`,
          ).bind(rawKey, it.real_category_id, now).run();
        }
        await c.env.DB.prepare(
          `UPDATE transactions SET real_category_id = ?
           WHERE source = 'mono' AND real_category_id IS NULL
             AND json_extract(raw_json, '$.description') = ?`,
        ).bind(it.real_category_id, rawKey).run();
      }
    }
  }
  return c.json({ ok: true, saved: (b.items ?? []).length });
});

// ---- weekly AI insight (§6.6) -----------------------------------------------

api.get("/insight", async (c) => {
  const { getStoredInsight } = await import("../lib/insight.ts");
  return c.json(await getStoredInsight(c.env));
});

// Manual trigger (cron also runs it). ?days= sets and persists the coverage window.
api.post("/insight/generate", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const days = Number(new URL(c.req.url).searchParams.get("days")) || undefined;
  const { buildAndStoreInsight } = await import("../lib/insight.ts");
  try {
    return c.json(await buildAndStoreInsight(c.env, days));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// ---- AI advisor: financial profile + structured advice ----------------------

api.get("/profile", async (c) => {
  const { getProfile } = await import("../lib/advisor.ts");
  return c.json({ text: await getProfile(c.env) });
});

api.put("/profile", async (c) => {
  const { text } = await c.req.json<{ text?: string }>();
  const { setProfile } = await import("../lib/advisor.ts");
  await setProfile(c.env, (text ?? "").slice(0, 4000));
  return c.json({ ok: true });
});

api.get("/advisor", async (c) => {
  const { getStoredAdvice } = await import("../lib/advisor.ts");
  return c.json(await getStoredAdvice(c.env));
});

api.get("/advisor/history", async (c) => {
  const { getAdviceHistory } = await import("../lib/advisor.ts");
  return c.json(await getAdviceHistory(c.env));
});

api.delete("/advisor/history", async (c) => {
  const { clearAdviceHistory } = await import("../lib/advisor.ts");
  await clearAdviceHistory(c.env);
  return c.json({ ok: true });
});

// Порада. Якщо AI недоступний (нема ключа / ліміт / збій моделі) — НЕ віддаємо порожнечу
// й не ховаємось за 502: рахуємо детермінований fallback із канонічних чисел і кажемо, чому
// він тут (`fallback_reason`). Краще деградувати, ніж мовчати (§Обробка помилок).
api.post("/advisor/generate", async (c) => {
  const { buildAdvice, fallbackAdvice } = await import("../lib/advisor.ts");
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json(await fallbackAdvice(c.env, "AI-ключ не налаштовано на цьому середовищі."));
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
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const body = await c.req.json<{ messages?: { role: string; content: string }[]; attachedTxIds?: string[] }>();
  const msgs = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12) as { role: "user" | "assistant"; content: string }[];
  if (!msgs.length) return c.json({ error: "messages required" }, 400);
  const attached = Array.isArray(body.attachedTxIds) ? body.attachedTxIds.filter((x) => typeof x === "string").slice(0, 10) : [];
  const { chatReply } = await import("../lib/advisor.ts");
  try {
    return c.json(await chatReply(c.env, msgs, attached));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §A1: шар фактів про світ. Список / додати (ручний) / підтвердити-скасувати / видалити.
// Гейт: лише confirmed факт із коригуванням рухає числа (categoryMonthlyLevels).
api.get("/facts", async (c) => {
  const { listFacts } = await import("../lib/advisor.ts");
  return c.json(await listFacts(c.env));
});

// §SPLIT: спліт транзакції на кілька категорій. GET — частини tx; PUT — замінити всі (порожній
// масив = прибрати спліт). Валідація: лише витрата, ≥2 частини, кожна <0, сума частин = сумі tx.
// Спліт міняє категорійну аналітику → інвалідуємо Tx/Summary/Advice на клієнті.
api.get("/transactions/:id/splits", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.category_id, s.amount, cat.name AS category_name, cat.color AS category_color
     FROM tx_splits s LEFT JOIN categories cat ON cat.id = s.category_id
     WHERE s.tx_id = ? ORDER BY s.id`,
  ).bind(c.req.param("id")).all();
  return c.json(rows.results ?? []);
});

api.put("/transactions/:id/splits", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ splits?: { category_id: number; amount: number }[] }>().catch(() => ({ splits: [] }));
  const splits = (body.splits ?? []).map((p) => ({ category_id: Number(p.category_id), amount: Math.round(Number(p.amount)) }));
  const tx = await c.env.DB.prepare("SELECT amount FROM transactions WHERE id = ?").bind(id).first<{ amount: number }>();
  if (!tx) return c.json({ error: "Операцію не знайдено" }, 404);
  if (splits.length > 0) {
    if (tx.amount >= 0) return c.json({ error: "Ділити можна лише витрату" }, 400);
    if (splits.length < 2) return c.json({ error: "Потрібно щонайменше 2 частини" }, 400);
    if (splits.some((p) => !p.category_id || !Number.isFinite(p.amount) || p.amount >= 0)) {
      return c.json({ error: "Кожна частина: категорія + сума < 0" }, 400);
    }
    const sum = splits.reduce((s, p) => s + p.amount, 0);
    if (sum !== tx.amount) return c.json({ error: `Сума частин має дорівнювати сумі операції (${tx.amount})` }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const stmts = [c.env.DB.prepare("DELETE FROM tx_splits WHERE tx_id = ?").bind(id)];
  for (const p of splits) {
    stmts.push(c.env.DB.prepare("INSERT INTO tx_splits (tx_id, category_id, amount, created_at) VALUES (?, ?, ?, ?)").bind(id, p.category_id, p.amount, now));
  }
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, count: splits.length });
});

// ---- Центр сповіщень (ROADMAP §Черга 2, v1 in-app) ---------------------------
// Стрічка того, що система «хоче сказати». Уся логіка — `lib/notify.ts` (ЄДИНЕ джерело),
// тут лише транспорт. Генерація йде добовим кроном; `/notifications/generate` — ручний прогін.
api.get("/notifications", async (c) => {
  const url = new URL(c.req.url);
  const { listNotifications } = await import("../lib/notify.ts");
  return c.json(await listNotifications(c.env, {
    limit: Number(url.searchParams.get("limit") ?? 60),
    kind: url.searchParams.get("kind"),
    unreadOnly: url.searchParams.get("unread") === "1",
  }));
});

api.post("/notifications/read", async (c) => {
  const body = await c.req.json<{ ids?: number[] }>().catch(() => ({ ids: [] }));
  const ids = (body.ids ?? []).map(Number).filter(Number.isFinite);
  const { markRead, unreadCount } = await import("../lib/notify.ts");
  await markRead(c.env, ids);
  return c.json({ ok: true, unread: await unreadCount(c.env) });
});

api.post("/notifications/read-all", async (c) => {
  const { markAllRead } = await import("../lib/notify.ts");
  await markAllRead(c.env);
  return c.json({ ok: true, unread: 0 });
});

api.delete("/notifications", async (c) => {
  const { clearNotifications } = await import("../lib/notify.ts");
  await clearNotifications(c.env);
  return c.json({ ok: true });
});

api.post("/notifications/generate", async (c) => {
  const { generateNotifications } = await import("../lib/notify.ts");
  return c.json(await generateNotifications(c.env));
});

api.get("/notifications/prefs", async (c) => {
  const { getPrefs } = await import("../lib/notify.ts");
  return c.json(await getPrefs(c.env));
});

api.put("/notifications/prefs", async (c) => {
  const body = await c.req.json<Record<string, boolean>>().catch(() => ({}));
  const { setPrefs } = await import("../lib/notify.ts");
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

async function readFilters(db: D1Database): Promise<SavedFilter[]> {
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
  if (!name) return c.json({ error: "Потрібна назва" }, 400);
  if (!query) return c.json({ error: "Немає жодного активного фільтра" }, 400);

  const list = await readFilters(c.env.DB);
  if (list.length >= 24) return c.json({ error: "Забагато збережених фільтрів (максимум 24)" }, 400);
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
  const likes = variants.map((v) => `%${v}%`);
  const orLike = (col: string) => `(${variants.map(() => `${col} LIKE ?`).join(" OR ")})`;

  const [merchants, categories, transactions] = await Promise.all([
    c.env.DB.prepare(
      `SELECT t.merchant AS name, COUNT(DISTINCT t.id) AS n, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE ${orLike("t.merchant")} AND ${SPEND_WHERE}
       GROUP BY t.merchant ORDER BY spent DESC LIMIT 6`,
    ).bind(...likes).all<{ name: string; n: number; spent: number }>(),
    c.env.DB.prepare(
      `SELECT c.id, c.name, c.color, p.name AS parent_name
       FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
       WHERE ${orLike("c.name")} ORDER BY c.parent_id IS NOT NULL, c.name LIMIT 6`,
    ).bind(...likes).all<{ id: number; name: string; color: string | null; parent_name: string | null }>(),
    c.env.DB.prepare(
      `SELECT t.id, t.time, t.amount, t.currency_code, t.merchant, c.name AS category_name
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${orLike("t.merchant")} OR ${orLike("t.comment")} OR ${orLike("t.user_note")}
       ORDER BY t.time DESC LIMIT 6`,
    ).bind(...likes, ...likes, ...likes)
      .all<{ id: string; time: number; amount: number; currency_code: number; merchant: string | null; category_name: string | null }>(),
  ]);

  return c.json({
    merchants: merchants.results ?? [],
    categories: categories.results ?? [],
    transactions: transactions.results ?? [],
  });
});

// §A5: вбудований корпус знань — метадані для UI (сам текст іде в промт чату, не сюди).
api.get("/knowledge", async (c) => {
  const { knowledgeMeta } = await import("../lib/knowledge/index.ts");
  return c.json(knowledgeMeta());
});

// Спарклайни: 6-міс місячні витрати на КАТЕГОРІЮ й на МЕРЧАНТА (канон stats.ts, зведено в ₴).
// Мапа {ключ: [6 значень копійок]} + буксети-місяці. Клієнт малює міні-тренд у рядках списків.
api.get("/analytics/spark", async (c) => {
  const N = 6;
  const nd = new Date();
  const from = Math.floor(new Date(nd.getFullYear(), nd.getMonth() - (N - 1), 1).getTime() / 1000);
  const buckets: string[] = [];
  for (let i = N - 1; i >= 0; i--) {
    const dt = new Date(nd.getFullYear(), nd.getMonth() - i, 1);
    buckets.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`);
  }
  const bIdx = new Map(buckets.map((b, i) => [b, i]));
  const { mult } = valueMode(await getRates(c.env.DB), null);
  const [cat, mer] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, strftime('%Y-%m', t.time, 'unixepoch') AS m, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND ${SPEND_WHERE} GROUP BY ${EFF_CAT_ID}, m`,
    ).bind(from).all<{ id: number; m: string; spent: number }>(),
    c.env.DB.prepare(
      `SELECT t.merchant AS name, strftime('%Y-%m', t.time, 'unixepoch') AS m, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND ${SPEND_WHERE} AND t.merchant IS NOT NULL GROUP BY t.merchant, m`,
    ).bind(from).all<{ name: string; m: string; spent: number }>(),
  ]);
  const categories: Record<string, number[]> = {};
  for (const r of cat.results ?? []) {
    if (r.id == null) continue;
    const arr = (categories[String(r.id)] ??= buckets.map(() => 0));
    const i = bIdx.get(r.m); if (i != null) arr[i] = Math.round(r.spent);
  }
  const merchants: Record<string, number[]> = {};
  for (const r of mer.results ?? []) {
    const arr = (merchants[r.name] ??= buckets.map(() => 0));
    const i = bIdx.get(r.m); if (i != null) arr[i] = Math.round(r.spent);
  }
  return c.json({ buckets, categories, merchants });
});

// §H: детермінований Індекс фінздоров'я (без AI) + запис скору за добу для тренду в часі.
api.get("/analytics/health", async (c) => {
  const { financeHealth } = await import("../lib/advisor.ts");
  const h = await financeHealth(c.env);
  const now = Math.floor(Date.now() / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  try {
    await c.env.DB.prepare(
      "INSERT INTO health_history (day, score, ts) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET score = excluded.score, ts = excluded.ts",
    ).bind(day, h.score, now).run();
    const since = new Date((now - 45 * 86400) * 1000).toISOString().slice(0, 10);
    const rows = await c.env.DB.prepare(
      "SELECT day, score FROM health_history WHERE day >= ? ORDER BY day",
    ).bind(since).all<{ day: string; score: number }>();
    return c.json({ ...h, trend: rows.results ?? [] });
  } catch {
    return c.json({ ...h, trend: [] }); // таблиця може лагати на remote до міграції
  }
});

api.post("/facts", async (c) => {
  const { addFact } = await import("../lib/advisor.ts");
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
  const { confirmFact } = await import("../lib/advisor.ts");
  const on = (await c.req.json<{ on?: boolean }>().catch(() => ({ on: true }))).on !== false;
  await confirmFact(c.env, Number(c.req.param("id")), on);
  return c.json({ ok: true });
});

api.delete("/facts/:id", async (c) => {
  const { deleteFact } = await import("../lib/advisor.ts");
  await deleteFact(c.env, Number(c.req.param("id")));
  return c.json({ ok: true });
});

// §GR2: AI-оцінка групи (структуровані факти) + чат по конкретній групі.
api.post("/events/:id/ai", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const { evaluateGroupAdvice } = await import("../lib/advisor.ts");
  try {
    const r = await evaluateGroupAdvice(c.env, Number(c.req.param("id")));
    return r ? c.json(r) : c.json({ error: "not_found" }, 404);
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

api.post("/events/:id/chat", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const body = await c.req.json<{ messages?: { role: string; content: string }[] }>();
  const msgs = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12) as { role: "user" | "assistant"; content: string }[];
  if (!msgs.length) return c.json({ error: "messages required" }, 400);
  const { chatAboutGroup } = await import("../lib/advisor.ts");
  try {
    return c.json(await chatAboutGroup(c.env, Number(c.req.param("id")), msgs));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// Інлайн-чат по конкретній операції: обговорити/уточнити з AI; він може оновити
// категорію чи прапорець переказу, коли з розмови стало ясно, що це.
api.post("/transactions/:id/chat", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const body = await c.req.json<{ messages?: { role: string; content: string }[] }>();
  const msgs = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12) as { role: "user" | "assistant"; content: string }[];
  if (!msgs.length) return c.json({ error: "messages required" }, 400);
  const { chatAboutTx } = await import("../lib/advisor.ts");
  try {
    return c.json(await chatAboutTx(c.env, c.req.param("id"), msgs));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// AI-план бюджету: пропозиції місячних лімітів-конвертів (приймаються на /plan).
api.post("/budgets/propose", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const { proposeBudgets } = await import("../lib/advisor.ts");
  try {
    return c.json(await proposeBudgets(c.env));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §3 діалоговий бюджет: чат, у якому AI пропонує/коригує ліміти й пояснює чому.
api.post("/budgets/chat", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not set" }, 400);
  const { messages } = await c.req.json<{ messages: { role: "user" | "assistant"; content: string }[] }>();
  const { budgetChatReply } = await import("../lib/advisor.ts");
  try {
    return c.json(await budgetChatReply(c.env, messages ?? []));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// ---- manual accounts (позамоно картка / крипта, §5) -------------------------

api.post("/accounts/manual", async (c) => {
  const b = await c.req.json<{ type: "manual_card" | "crypto"; title: string; currency_code: number; balance: number }>();
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_manual, is_active, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 1, 1, ?)`,
  ).bind(id, b.type, b.title, b.currency_code, b.balance, Math.floor(Date.now() / 1000)).run();
  return c.json({ ok: true, id });
});

api.patch("/accounts/manual/:id", async (c) => {
  const b = await c.req.json<{ balance?: number; title?: string }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (b.balance !== undefined) { sets.push("balance = ?"); binds.push(b.balance); }
  if (b.title !== undefined) { sets.push("title = ?"); binds.push(b.title); }
  if (!sets.length) return c.json({ ok: true });
  sets.push("updated_at = ?"); binds.push(Math.floor(Date.now() / 1000));
  await c.env.DB.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ? AND is_manual = 1`)
    .bind(...binds, c.req.param("id")).run();
  return c.json({ ok: true });
});

// Cached rates map (currency code → UAH per unit) + last-updated, for client-side
// ≈₴ conversion of FX cards/jars. Same source computeSummary uses.
api.get("/rates", async (c) => {
  const ratesRaw = await c.env.DB.prepare("SELECT value FROM app_state WHERE key = 'rates'").first<{ value: string }>();
  const updRaw = await c.env.DB.prepare("SELECT value FROM app_state WHERE key = 'rates_updated'").first<{ value: string }>();
  return c.json({
    rates: ratesRaw ? (JSON.parse(ratesRaw.value) as Record<string, number>) : {},
    updated: updRaw ? Number(updRaw.value) : null,
  });
});

// Перейменувати рахунок (напр. банку — mono дає generic «БАНКА»). Title — лише
// показ, тож дозволяємо для будь-якого рахунку; синк банок його вже не перезапише.
api.patch("/accounts/:id/title", async (c) => {
  const { title } = await c.req.json<{ title?: string }>();
  if (!title?.trim()) return c.json({ error: "title required" }, 400);
  await c.env.DB.prepare("UPDATE accounts SET title = ? WHERE id = ?").bind(title.trim(), c.req.param("id")).run();
  return c.json({ ok: true });
});

// §R3: роль рахунку (ліквідний/інвестиційний) + опис для AI. Для будь-якого рахунку.
api.patch("/accounts/:id/meta", async (c) => {
  const b = await c.req.json<{ role?: "liquid" | "investment"; ai_note?: string }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (b.role !== undefined) { sets.push("role = ?"); binds.push(b.role === "investment" ? "investment" : "liquid"); }
  if (b.ai_note !== undefined) { sets.push("ai_note = ?"); binds.push(b.ai_note.trim() || null); }
  if (!sets.length) return c.json({ ok: true });
  await c.env.DB.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, c.req.param("id")).run();
  return c.json({ ok: true });
});

// Ручний тригер проактивного TG-пушу (тест без очікування тижневого крону).
api.post("/tg/proactive", async (c) => {
  const { runWeeklyProactive } = await import("../lib/proactive.ts");
  try {
    return c.json(await runWeeklyProactive(c.env));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §F2 крок 2: скан вагомих непояснених операцій за 14 днів → TG-алерти (ручний тест/фолбек).
api.post("/alerts/scan", async (c) => {
  const { scanAlerts } = await import("../lib/alert.ts");
  try {
    return c.json(await scanAlerts(c.env, new URL(c.req.url).origin));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// Refresh currency rates cache from public mono endpoint (call daily / on demand).
api.post("/rates/refresh", async (c) => {
  const { getCurrencyRates } = await import("../lib/mono.ts");
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
