// `/advisor/*`, `/insight/*` and `/facts/*` — the AI adviser surface.
//
// Every number the model is shown comes from ONE snapshot, `collectFinanceSnapshot()`: the chat
// and the adviser must not build their own context, or they answer with different figures about
// the same money. Confirmed facts adjust the canon inside `categoryMonthlyLevels`, never here.
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes, normChatMessages } from "./_shared.ts";

export const advisor = apiRoutes();

// ---- weekly AI insight (§6.6) -----------------------------------------------

advisor.get("/insight", async (c) => {
  const { getStoredInsight } = await import("../../lib/ai/insight.ts");
  return c.json(await getStoredInsight(c.env));
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
  return c.json(await getAdviceHistory(c.env));
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

// §A1: шар фактів про світ. Список / додати (ручний) / підтвердити-скасувати / видалити.
// Гейт: лише confirmed факт із коригуванням рухає числа (categoryMonthlyLevels).
advisor.get("/facts", async (c) => {
  const { listFacts } = await import("../../lib/ai/advisor.ts");
  return c.json(await listFacts(c.env));
});

advisor.post("/facts", async (c) => {
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

advisor.post("/facts/:id/confirm", async (c) => {
  const { confirmFact } = await import("../../lib/ai/advisor.ts");
  const on = (await c.req.json<{ on?: boolean }>().catch(() => ({ on: true }))).on !== false;
  await confirmFact(c.env, Number(c.req.param("id")), on);
  return c.json({ ok: true });
});

advisor.delete("/facts/:id", async (c) => {
  const { deleteFact } = await import("../../lib/ai/advisor.ts");
  await deleteFact(c.env, Number(c.req.param("id")));
  return c.json({ ok: true });
});
