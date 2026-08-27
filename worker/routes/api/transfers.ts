// `/transfers/*` — detection and review of transfers between the owner's own accounts.
// A PAIR is `transfer_pair_id` and nothing else; `is_transfer=1` alone does not collapse two
// rows into one (five different paths set it and none of them assigns a pair id).
import * as txRepo from "../../repo/transactions.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes } from "./_shared.ts";

export const transfers = apiRoutes();

// Detect internal transfers between own accounts (opposite equal amounts, ±15 min).
transfers.post("/transfers/detect", async (c) => {
  const { detectTransfers } = await import("../../lib/finance/transfers.ts");
  const marked = await detectTransfers(c.env);
  return c.json({ ok: true, marked });
});

// §F2 крок 2: AI-розмітка реальної категорії для операцій у бакеті «Перекази і зняття».
// Малий батч за виклик, клієнт повторює поки remaining > 0. Навчене застосовується без AI.
transfers.post("/transfers/categorize", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { categorizeTransfers } = await import("../../lib/ai/transfers-ai.ts");
  try {
    return c.json(await categorizeTransfers(c.env));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// Скільки переказів/знять ще без реальної категорії (для стану кнопки).
transfers.get("/transfers/status", async (c) => {
  const { transfersPending } = await import("../../lib/ai/transfers-ai.ts");
  return c.json({ pending: await transfersPending(c.env) });
});

// §R2-ST4: рев'ю. Проганяє AI по батчу нерозмічених переказів і повертає пропозиції
// (зі збереженням у БД) для перегляду/правки. needs_attention = AI не впевнений/не визначив.
transfers.post("/transfers/review", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { reviewTransfers } = await import("../../lib/ai/transfers-ai.ts");
  const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? 12);
  try {
    return c.json(await reviewTransfers(c.env, limit));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §C2: перепрогнати ОДИН переказ через AI з підказкою користувача («описати для AI»).
transfers.post("/transfers/review/one", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const b = await c.req.json<{ id?: string; hint?: string }>();
  if (!b.id || !b.hint?.trim()) return c.json({ error: "id and hint required" }, 400);
  const { reviewTransferWithHint } = await import("../../lib/ai/transfers-ai.ts");
  try {
    const row = await reviewTransferWithHint(c.env, b.id, b.hint);
    return row ? c.json(row) : c.json({ error: "not_found" }, 404);
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §R2-ST4: зберегти правки рев'ю — масово оновити real_category_id по рядках.
// Кожен рядок може навчати alias (щоб схожі перекази авто-розмічались надалі).
transfers.post("/transfers/review/save", async (c) => {
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
