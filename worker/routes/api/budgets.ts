// `/budgets/*` — envelope budgets, their AI proposal and the budget chat.
// Limit-versus-spent is `budgetStatus()` in lib/finance/stats.ts and nowhere else.
import { getRates } from "../../lib/finance/finance.ts";
import {
  valueMode, categoryMonthlyLevels, } from "../../lib/finance/stats.ts";
import * as categoriesRepo from "../../repo/categories.ts";
import * as budgetsRepo from "../../repo/budgets.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes, normChatMessages } from "./_shared.ts";
import type { Budget } from "../../../shared/types.ts";
import type { AutoBudget } from "../../../shared/api/planning.ts";

export const budgets = apiRoutes();

// ---- budgets & planned ------------------------------------------------------

budgets.get("/budgets", async (c) => {
  return c.json(await budgetsRepo.listAll(c.env.DB) satisfies Budget[]);
});

// Idempotent set: one budget per category+period. amount<=0 clears it.
budgets.put("/budgets", async (c) => {
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
budgets.get("/budgets/auto", async (c) => {
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
  } satisfies AutoBudget);
});

budgets.post("/budgets/auto", async (c) => {
  const b = await c.req.json<{ items?: { category_id: number; amount: number }[] }>()
    .catch(() => ({} as { items?: { category_id: number; amount: number }[] }));
  const items = (b.items ?? [])
    .map((i) => ({ category_id: Number(i.category_id), amount: Math.round(Number(i.amount)) }))
    .filter((i) => Number.isFinite(i.category_id) && i.amount > 0);
  if (!items.length) return c.json({ error: st(c.get("locale"), "errNothingToApply") }, 400);

  await budgetsRepo.setMonthlyBatch(c.env.DB, items);
  return c.json({ ok: true, applied: items.length });
});

// AI-план бюджету: пропозиції місячних лімітів-конвертів (приймаються на /plan).
budgets.post("/budgets/propose", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { proposeBudgets } = await import("../../lib/ai/advisor.ts");
  try {
    return c.json(await proposeBudgets(c.env));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// §3 діалоговий бюджет: чат, у якому AI пропонує/коригує ліміти й пояснює чому.
budgets.post("/budgets/chat", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { messages } = await c.req.json<{ messages: { role: "user" | "assistant"; content: string }[] }>();
  const { budgetChatReply } = await import("../../lib/ai/advisor.ts");
  try {
    return c.json(await budgetChatReply(c.env, normChatMessages(messages)));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});
