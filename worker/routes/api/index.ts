// Core REST API for the dashboard. All money is minor units; the client divides by 100.
//
// This file owns the request-wide middleware and MOUNTS the domain modules; the handlers
// themselves live in the sibling files. Mount order is behaviour — Hono matches in registration
// order, and `/transactions/frequent` has to be reachable before `/transactions/:id` (a real
// outage, recorded in CLAUDE.md). Each domain keeps its own literals above its own patterns, and
// no two domains share a path prefix, which is what makes the mount order below safe to read.
import { apiRoutes, normChatMessages } from "./_shared.ts";
import { analytics } from "./analytics.ts";
import { budgets } from "./budgets.ts";
import { planned } from "./planned.ts";
import { categories } from "./categories.ts";
import { accounts } from "./accounts.ts";
import { transactions } from "./transactions.ts";
import { setState, getState } from "../../lib/finance/repo.ts";
import { getRates } from "../../lib/finance/finance.ts";
// NOTE: no `STATS_JOINS` / `SPEND_WHERE` / `amountSum` here any more — the canonical SQL
// fragments now live behind `worker/repo/`, and a route that needs one is a route that is about
// to grow its own definition of "spending". What is left below is JS-side canon (period bounds,
// levels, projections), which routes are allowed to call.
import {
  valueMode, uahMult, type PeriodMode,
} from "../../lib/finance/stats.ts";
import type { AppDb } from "../../lib/platform/db-shim.ts";
import * as txRepo from "../../repo/transactions.ts";
import * as goalsRepo from "../../repo/goals.ts";
import * as eventsRepo from "../../repo/events.ts";
import * as reportsRepo from "../../repo/reports.ts";
import * as knowledgeRepo from "../../repo/knowledge.ts";
import * as stateRepo from "../../repo/state.ts";
// `catNameSql` is deliberately absent: it produces SQL, and the route layer no longer writes any.
import { ownerLocale } from "../../lib/finance/categories-i18n.ts";
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
api.route("/", budgets);
api.route("/", planned);
api.route("/", categories);
api.route("/", accounts);
api.route("/", transactions);

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

// §Хвіст C: глобальний лічильник витрат AI — «$ за сьогодні / цей місяць / за весь час».
api.get("/ai-usage", async (c) => {
  const { readUsageStats } = await import("../../lib/ai/ai.ts");
  return c.json(await readUsageStats(c.env));
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
