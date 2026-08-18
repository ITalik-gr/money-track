// `/events/*` — event groups (a trip, a renovation): a label over transactions plus the plan
// line items belonging to it, with an AI summary and chat on top.
import { getRates, uahToBaseMinor, baseToUah } from "../../lib/finance/money.ts";
import {
  baseMult, } from "../../lib/finance/stats.ts";
import * as eventsRepo from "../../repo/events.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes, normChatMessages } from "./_shared.ts";
import type { EventWithAgg } from "../../../shared/api/platform.ts";

export const events = apiRoutes();

// ---- events / groups (івент / проєкт / спец-день) ---------------------------

// Список подій із агрегатами (скільки транзакцій і сума витрат по кожній).
events.get("/events", async (c) => {
  // Рахуємо ВСІ операції групи (вкл. holds — тест/мono-холди мають лічитись).
  // ⚠️ Раніше тут стояв фільтр `currency_code = 980`, тобто валютні витрати групи просто
  // НЕ рахувались. Для подорожі це найгірше можливе місце для такої дірки — саме там
  // валюта і трапляється, і бюджет поїздки виглядав би виконаним. Зводимо в ₴ як усюди.
  const rates = await getRates(c.env);
  // §BASE-CUR: `spent` comes through the canon (already in the base) but `budget` is a stored
  // hryvnia column, so an unconverted pair would report a trip as 2% of its budget.
  const rows = await eventsRepo.listWithTotals(c.env.DB, baseMult(rates));
  return c.json(rows.map((e) => ({
    ...e, budget: e.budget == null ? e.budget : uahToBaseMinor(e.budget, rates),
  })) satisfies EventWithAgg[]);
});

// Бюджет події («скільки закладаю на цю подорож»). amount<=0 або null — прибрати ліміт.
events.patch("/events/:id", async (c) => {
  const id = Number(c.req.param("id"));
  type Patch = { budget?: number | null; name?: string; note?: string | null; goal_id?: number | null };
  const b = await c.req.json<Patch>().catch(() => ({} as Patch));
  await eventsRepo.update(c.env.DB, id, {
    ...(b.budget !== undefined
      ? { budget: b.budget == null || b.budget <= 0 ? null : baseToUah(Math.round(b.budget), await getRates(c.env)) } : {}),
    // A blank name is IGNORED rather than rejected: this endpoint is also how the budget alone
    // is set, and failing the whole patch over an empty field the caller did not mean to send
    // would block that.
    ...(b.name !== undefined && b.name.trim() ? { name: b.name.trim() } : {}),
    ...(b.note !== undefined ? { note: b.note?.trim() || null } : {}),
    // §EVENT-GOAL: `null` is the unlink, so `undefined` is the only "leave it alone".
    ...(b.goal_id !== undefined
      ? { goal_id: b.goal_id == null || !Number.isFinite(b.goal_id) ? null : Math.round(b.goal_id) } : {}),
  });
  return c.json({ ok: true });
});

events.post("/events", async (c) => {
  const b = await c.req.json<{ name: string; kind?: string; color?: string; icon?: string; note?: string }>();
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = await eventsRepo.create(c.env.DB, {
    name: b.name.trim(), kind: b.kind ?? "event",
    color: b.color ?? null, icon: b.icon ?? null, note: b.note ?? null,
    created_at: Math.floor(Date.now() / 1000),
  });
  return c.json({ ok: true, id });
});

events.delete("/events/:id", async (c) => {
  const id = Number(c.req.param("id"));
  // Order matters and the spending outlives the event: the transactions are unlinked first, and
  // only the GROUP is archived. Deleting a trip must never delete what was spent on it.
  await eventsRepo.unlinkTransactions(c.env.DB, id);
  await eventsRepo.archive(c.env.DB, id);
  return c.json({ ok: true });
});

// Деталь події: підсумок + список транзакцій.
events.get("/events/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const event = await eventsRepo.find(c.env.DB, id);
  if (!event) return c.json({ error: "not_found" }, 404);
  // Підсумки рахує СЕРВЕР і зводить у ₴. Раніше сторінка рахувала їх сама, фільтруючи
  // `currency_code === 980`, тож валютні операції випадали — і та сама група показувала
  // на сторінці меншу суму, ніж у списку. Одна цифра має бути одна.
  const rates = await getRates(c.env);
  const loc = c.get("locale");
  const [txs, agg, plannedItems] = await Promise.all([
    eventsRepo.transactions(c.env.DB, loc, id),
    eventsRepo.totals(c.env.DB, baseMult(rates), id),
    eventsRepo.plannedItems(c.env.DB, loc, id),
  ]);
  // Plan lines and the event budget are stored in hryvnia (§BASE-CUR); the totals beside them
  // are canonical. Convert the stored side, once, here.
  const planned = plannedItems.map((p) => ({ ...p, amount: uahToBaseMinor(p.amount, rates) }));
  return c.json({
    event: { ...event, budget: event.budget == null ? event.budget : uahToBaseMinor(event.budget, rates) },
    transactions: txs,
    spent: agg?.spent ?? 0, income: agg?.income ?? 0,
    planned,
    planned_total: planned.reduce((s, p) => s + p.amount, 0),
  });
});

// Plan line items CRUD (P2.3). Amounts arrive in the READER's base and are stored in hryvnia.
events.post("/events/:id/planned", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ label?: string; amount?: number; category_id?: number | null }>()
    .catch(() => ({} as { label?: string; amount?: number; category_id?: number | null }));
  if (!b.label?.trim() || !b.amount || b.amount <= 0) return c.json({ error: "label and positive amount required" }, 400);
  const catId = typeof b.category_id === "number" ? b.category_id : null;
  const newId = await eventsRepo.addPlannedItem(
    c.env.DB, id, b.label.trim(), baseToUah(Math.round(b.amount), await getRates(c.env)), catId,
    Math.floor(Date.now() / 1000));
  return c.json({ ok: true, id: newId });
});

events.delete("/events/:id/planned/:pid", async (c) => {
  await eventsRepo.deletePlannedItem(
    c.env.DB, Number(c.req.param("id")), Number(c.req.param("pid")));
  return c.json({ ok: true });
});

// §GR2: AI-оцінка групи (структуровані факти) + чат по конкретній групі.
events.post("/events/:id/ai", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { evaluateGroupAdvice } = await import("../../lib/ai/advisor.ts");
  try {
    const r = await evaluateGroupAdvice(c.env, Number(c.req.param("id")));
    return r ? c.json(r) : c.json({ error: "not_found" }, 404);
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

events.post("/events/:id/chat", async (c) => {
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
