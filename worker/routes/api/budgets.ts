// `/budgets/*` — envelope budgets, their AI proposal and the budget chat.
// Limit-versus-spent is `budgetStatus()` in lib/finance/budgets.ts and nowhere else.
import { getRates } from "../../lib/finance/finance.ts";
import {
  valueMode, categoryMonthlyLevels, localYm, localMonthStart,
} from "../../lib/finance/stats.ts";
import * as categoriesRepo from "../../repo/categories.ts";
import * as budgetsRepo from "../../repo/budgets.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes, normChatMessages } from "./_shared.ts";
import type { Budget } from "../../../shared/types.ts";
import { budgetStatus } from "../../lib/finance/budgets.ts";
import type { AutoBudget, AutoBudgetItem, BudgetStatusList } from "../../../shared/api/planning.ts";

export const budgets = apiRoutes();

// ---- budgets & planned ------------------------------------------------------

budgets.get("/budgets", async (c) => {
  return c.json(await budgetsRepo.listAll(c.env.DB) satisfies Budget[]);
});

/**
 * §BUDGET-FORECAST — limit, spent AND where the month is heading, from the canon.
 *
 * ⚠️ Declared ABOVE `PUT /budgets` is not required (different method), but it IS above any
 * `/budgets/:id` route — lint C7.
 *
 * This endpoint exists because the client was computing the same thing itself: `EnvelopeGrid`
 * combined `/budgets` with `/analytics/by-category` and derived its own spent-vs-limit, which is
 * exactly the duplication `budgetStatus` was created to end (the Telegram push had its own SQL and
 * quoted different numbers for the same envelope). One more consumer of the canon, and one less
 * private definition of "how full is this envelope".
 */
budgets.get("/budgets/status", async (c) => {
  const rates = await getRates(c.env.DB);
  const { mult } = valueMode(rates, null);
  return c.json(await budgetStatus(c.env, mult) satisfies BudgetStatusList);
});

/**
 * Idempotent set: one budget per category+period.
 *
 * §BUDGET-ZERO — **0 is a value, not a deletion.** «Конверта тут немає» and «сюди я свідомо не
 * витрачаю» are different statements about money, and until now the API could only express the
 * first: `amount <= 0` deleted the row, so the second was unsayable and the two looked identical
 * on every screen. Removing an envelope is now its own verb (`DELETE` below) because it is its own
 * intention — a limit of zero is a plan, and no limit is the absence of one.
 *
 * A negative amount is still refused rather than clamped: it means the caller computed something
 * wrong, and silently storing 0 would hide that behind a plausible-looking envelope.
 */
budgets.put("/budgets", async (c) => {
  const b = await c.req.json<{ category_id: number; period: "month" | "week"; amount: number; rollover?: boolean }>();
  const amount = Math.round(Number(b.amount));
  if (!Number.isFinite(amount) || amount < 0) {
    return c.json({ error: st(c.get("locale"), "errBudgetNegative") }, 400);
  }
  await budgetsRepo.set(c.env.DB, b.category_id, b.period, amount, !!b.rollover);
  return c.json({ ok: true });
});

/**
 * Remove the envelope entirely — back to "this category is not budgeted".
 *
 * ⚠️ Above nothing that shadows it (lint C7): `/budgets/status` and `/budgets/auto` are literals
 * declared earlier and this is the only parameterised `/budgets/:…` route, on its own method.
 */
budgets.delete("/budgets/:categoryId", async (c) => {
  const categoryId = Number(c.req.param("categoryId"));
  if (!Number.isFinite(categoryId)) return c.json({ error: "bad id" }, 400);
  const period = new URL(c.req.url).searchParams.get("period") === "week" ? "week" : "month";
  await budgetsRepo.clear(c.env.DB, categoryId, period);
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
 * ⚠️ **§BUDGET-MEMORY: не ріжемо й те, чого людина ЖОДНОГО разу не втримала** — якщо конверт
 * провалено в половині закритих місяців, `trim` знімається (`basis: "missed"`). Доти пропозиція
 * була «витрачай на 10% менше» тому, хто рівно цю ціль не виконав чотири місяці поспіль.
 * GET віддає ПРОПОЗИЦІЮ (нічого не змінює), POST застосовує обрані — щоб один тап не
 * переписав мовчки вже налаштовані конверти.
 */
budgets.get("/budgets/auto", async (c) => {
  const url = new URL(c.req.url);
  const trim = Math.min(Math.max(Number(url.searchParams.get("trim") ?? 10), 0), 50) / 100;
  const rates = await getRates(c.env.DB);
  const { mult } = valueMode(rates, null);
  const now = Math.floor(Date.now() / 1000);

  const [levels, cats, currentByCat, record] = await Promise.all([
    categoryMonthlyLevels(c.env, mult, { now }),
    categoriesRepo.budgetable(c.env.DB, c.get("locale")),
    budgetsRepo.monthlyAmounts(c.env.DB),
    // §BUDGET-MEMORY: the last six CLOSED months. Six because that is the same window the rest of
    // the app reasons over (trends, income stability), and a shorter one would let a single bad
    // month rewrite the proposal.
    budgetsRepo.trackRecord(c.env.DB, localYm(localMonthStart(now, -6))),
  ]);

  const MIN_LEVEL = 30000; // 300 ₴/міс — дрібним категоріям конверт не потрібен
  const items = cats
    .map((cat) => {
      const level = levels.get(cat.id)?.level ?? 0;
      if (level < MIN_LEVEL) return null;
      const essential = cat.importance === "essential";
      const rec = record.get(cat.id);

      /**
       * §BUDGET-MEMORY — the proposal now knows whether the last limit was ever KEPT.
       *
       * Until now this was `level × (1 − trim)` for everyone: the same "spend 10% less" offered to
       * someone who has blown that exact target four months running. That is the app restating a
       * number already proven unachievable, and a limit you have never once met stops being a
       * budget — it is a permanent red bar you learn to scroll past.
       *
       * ⚠️ A missed record does NOT lower the ambition to whatever was spent — that would ratchet
       * the budget upward every time someone had a bad quarter, which is a spending plan that
       * agrees with all spending. It removes the TRIM and proposes the honest level, so the number
       * is achievable and the conversation moves to whether the level itself should change.
       * ⚠️ Two closed months minimum: one month is an anecdote, and the very first month after
       * switching an envelope on is the one most likely to be a surprise.
       */
      const missed = !!rec && rec.closed >= 2 && rec.over / rec.closed >= 0.5;
      const basis: AutoBudgetItem["basis"] =
        essential ? "essential" : missed ? "missed" : rec ? "kept" : "level";
      const raw = essential || missed ? Math.max(level, rec?.avg_spent ?? 0) : level * (1 - trim);
      // Округлюємо до 50 ₴ — «2 350 ₴» читається як рішення, «2 347 ₴» як шум обчислення.
      const suggested = Math.max(MIN_LEVEL, Math.round(raw / 5000) * 5000);
      return {
        category_id: cat.id, name: cat.name, color: cat.color,
        importance: cat.importance ?? "discretionary",
        essential,
        level, suggested,
        current: currentByCat.get(cat.id) ?? null,
        // The record travels WITH the number: a proposal that quietly stops trimming one row and
        // not another looks like a bug unless it says why (same rule as `carried` on the envelope).
        basis,
        months_closed: rec?.closed ?? 0,
        months_over: rec?.over ?? 0,
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
