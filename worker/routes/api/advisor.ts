// `/advisor/*`, `/insight/*` and `/facts/*` — the AI adviser surface.
//
// Every number the model is shown comes from ONE snapshot, `collectFinanceSnapshot()`: the chat
// and the adviser must not build their own context, or they answer with different figures about
// the same money. Confirmed facts adjust the canon inside `categoryMonthlyLevels`, never here.
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes, normChatMessages } from "./_shared.ts";
import type { Insight, AdviceHistoryItem, Fact } from "../../../shared/api/ai.ts";

export const advisor = apiRoutes();

// ---- weekly AI insight (§6.6) -----------------------------------------------

advisor.get("/insight", async (c) => {
  const { getStoredInsight } = await import("../../lib/ai/insight.ts");
  return c.json(await getStoredInsight(c.env) satisfies Insight | null);
});

// Manual trigger (cron also runs it). ?days= sets and persists the coverage window.
advisor.post("/insight/generate", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const days = Number(new URL(c.req.url).searchParams.get("days")) || undefined;
  const { buildAndStoreInsight } = await import("../../lib/ai/insight.ts");
  try {
    return c.json(await buildAndStoreInsight(c.env, days));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

advisor.get("/advisor", async (c) => {
  const { getStoredAdvice } = await import("../../lib/ai/advisor.ts");
  return c.json(await getStoredAdvice(c.env));
});

advisor.get("/advisor/history", async (c) => {
  const { getAdviceHistory } = await import("../../lib/ai/advisor.ts");
  return c.json(await getAdviceHistory(c.env) satisfies AdviceHistoryItem[]);
});

advisor.delete("/advisor/history", async (c) => {
  const { clearAdviceHistory } = await import("../../lib/ai/advisor.ts");
  await clearAdviceHistory(c.env);
  return c.json({ ok: true });
});

// Порада. Якщо AI недоступний (нема ключа / ліміт / збій моделі) — НЕ віддаємо порожнечу
// й не ховаємось за 502: рахуємо детермінований fallback із канонічних чисел і кажемо, чому
// він тут (`fallback_reason`). Краще деградувати, ніж мовчати (§Обробка помилок).
advisor.post("/advisor/generate", async (c) => {
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
//
// Наш веб-клієнт із 2026-08-07 ходить у `/advisor/chat/stream` (нижче). Ця форма лишається
// свідомо: вона віддає ОДИН JSON, тобто це те, що потрібно викликачу без стріму — і такий уже
// існує (Telegram-бот кличе `chatReply` напряму). Обидві стоять на одній функції, тож
// розійтись у відповідях вони не можуть.
advisor.post("/advisor/chat", async (c) => {
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

/**
 * Той самий чат, але відповідь ТЕЧЕ до читача, а не падає одним шматком у кінці.
 *
 * ⚠️ Літерал `/advisor/chat/stream` мусить лишатись НИЖЧЕ `/advisor/chat` за глибиною, а не за
 * порядком: у них різна кількість сегментів, тож вони не перекриваються (лінт C7 це і перевіряє).
 *
 * **Формат — NDJSON, не SSE.** Тут немає нічого, заради чого потрібен `EventSource`: ані типів
 * подій, ані реконекту, ані last-event-id. Рядок JSON на подію читається звичайним `fetch`
 * + `getReader()`, а помилку посеред потоку можна віддати тим самим `{error}`, який `errText()`
 * на клієнті вже вміє розгортати — тобто збій моделі на 20-й секунді лишається діагностованим,
 * а не перетворюється на обірваний текст.
 *
 * Помилка ПІСЛЯ першого байта не може змінити код статусу — він уже 200. Тому вона їде тілом
 * (`{error}`), і клієнт показує її як повідомлення, а не як мовчазний обрив.
 */
advisor.post("/advisor/chat/stream", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const body = await c.req.json<{ messages?: { role: string; content: string }[]; attachedTxIds?: string[] }>();
  const msgs = normChatMessages(body.messages);
  if (!msgs.length) return c.json({ error: "messages required" }, 400);
  const attached = Array.isArray(body.attachedTxIds) ? body.attachedTxIds.filter((x) => typeof x === "string").slice(0, 10) : [];

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (o: unknown) => writer.write(enc.encode(JSON.stringify(o) + "\n"));

  c.executionCtx.waitUntil((async () => {
    try {
      const { chatReply } = await import("../../lib/ai/advisor.ts");
      const { reply } = await chatReply(c.env, msgs, attached, (t) => { void send({ delta: t }); });
      // The whole text is sent again at the end, and deliberately: a client that joined late, or
      // dropped a chunk, must not be left holding a half-sentence it cannot tell from a finished
      // one. The client replaces what it accumulated with this.
      await send({ done: true, reply });
    } catch (e) {
      await send({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      await writer.close();
    }
  })());

  return new Response(readable, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      // Nothing between here and the browser may buffer the answer into one chunk — that would
      // reinstate exactly the wait this endpoint exists to remove.
      "x-accel-buffering": "no",
    },
  });
});

// §A1: шар фактів про світ. Список / додати (ручний) / підтвердити-скасувати / видалити.
// Гейт: лише confirmed факт із коригуванням рухає числа (categoryMonthlyLevels).
advisor.get("/facts", async (c) => {
  const { listFacts } = await import("../../lib/ai/facts.ts");
  return c.json(await listFacts(c.env) satisfies Fact[]);
});

advisor.post("/facts", async (c) => {
  const { addFact } = await import("../../lib/ai/facts.ts");
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

advisor.post("/facts/:id/confirm", async (c) => {
  const { confirmFact } = await import("../../lib/ai/facts.ts");
  const on = (await c.req.json<{ on?: boolean }>().catch(() => ({ on: true }))).on !== false;
  await confirmFact(c.env, Number(c.req.param("id")), on);
  return c.json({ ok: true });
});

advisor.delete("/facts/:id", async (c) => {
  const { deleteFact } = await import("../../lib/ai/facts.ts");
  await deleteFact(c.env, Number(c.req.param("id")));
  return c.json({ ok: true });
});
