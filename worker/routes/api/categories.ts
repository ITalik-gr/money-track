// `/categories/*` — the category tree. The delete is a CASCADE and its step ORDER is the
// behaviour: the harness enforces foreign keys, so a step moved after the row is deleted fails.
import * as categoriesRepo from "../../repo/categories.ts";
import { localizeCatName } from "../../lib/finance/categories-i18n.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes } from "./_shared.ts";
import type { Category } from "../../../shared/types.ts";
import type { CategoryOverview } from "../../../shared/api/analytics.ts";
import { normImportance } from "../../lib/finance/importance.ts";
import { deleteCategory } from "../../services/categories.ts";

export const categories = apiRoutes();

// ---- reference data ---------------------------------------------------------

categories.get("/categories", async (c) => {
  const rows = await categoriesRepo.listAll(c.env.DB);
  const loc = c.get("locale");
  // Localize seed names in JS (the row already carries `name`); user categories pass through.
  return c.json(rows.map((r) => ({ ...r, name: localizeCatName(loc, r.name) })) satisfies Category[]);
});

// ---- custom categories ------------------------------------------------------

categories.post("/categories", async (c) => {
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
categories.patch("/categories/:id", async (c) => {
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
categories.get("/categories/:id/usage", async (c) => {
  return c.json(await categoriesRepo.usage(c.env.DB, Number(c.req.param("id"))));
});

// Видалити категорію, перенісши всі прив'язки на іншу (reassign) або знявши їх (null).
// Захищена лише категорія «Перекази і зняття» (13) — на ній тримається логіка бакета.
categories.delete("/categories/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (id === 13) return c.json({ error: st(c.get("locale"), "errTransferCatLocked") }, 400);
  if (!(await categoriesRepo.exists(c.env.DB, id))) return c.json({ error: "not_found" }, 404);

  const raw = new URL(c.req.url).searchParams.get("reassign");
  const target = raw && raw !== "none" && Number(raw) !== id ? Number(raw) : null;

  try {
    await deleteCategory(c.env.DB, id, target);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

/**
 * §CATEGORY-PAGE — everything the category permalink needs that the Stats drill does not carry.
 *
 * ⚠️ Declared ABOVE `PATCH`/`DELETE /categories/:id` is not required (different methods), but it
 * IS above nothing that would shadow it — `overview` is a literal segment after the parameter, so
 * lint C7 is satisfied either way.
 *
 * Every number comes from the canon: the monthly level from `categoryMonthlyLevels`, the envelope
 * from `budgetStatus`, the trend and the split from `STATS_JOINS` + `SPEND_WHERE`. A page that
 * recomputed any of them would be the §CUR-PLAN mechanism starting over on a new screen.
 */
categories.get("/categories/:id/overview", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const url = new URL(c.req.url);
  const now = Math.floor(Date.now() / 1000);
  const to = Number(url.searchParams.get("to") ?? now);

  const { getRates } = await import("../../lib/finance/finance.ts");
  const stats = await import("../../lib/finance/stats.ts");
  const { budgetStatus } = await import("../../lib/finance/budgets.ts");
  const rates = await getRates(c.env.DB);
  const { mult } = stats.valueMode(rates, null);
  const loc = c.get("locale");

  /**
   * The default window is the MONTH, not a rolling 30 days.
   *
   * `budgetStatus` is month-to-date by definition, so with a 30-day default the two halves of this
   * one response would describe different periods — the tile would say "this month" over a window
   * that started in the previous one. The client passes the month start explicitly; this makes the
   * endpoint agree with itself for anyone who does not.
   */
  const from = Number(url.searchParams.get("from") ?? stats.localMonthStart(to));

  const row = await categoriesRepo.byId(c.env.DB, id);
  if (!row) return c.json({ error: "not_found" }, 404);

  const [levels, budgets, trend, split, children] = await Promise.all([
    stats.categoryMonthlyLevels(c.env, mult, { now: to }),
    budgetStatus(c.env, mult, now),
    categoriesRepo.monthlyTrend(c.env.DB, mult, id, stats.localMonthStart(to, -11), to),
    categoriesRepo.recurringSplit(c.env.DB, mult, id, from, to, stats.isRecurringExpr(stats.defaultRefFrom(to), to)),
    categoriesRepo.childrenOf(c.env.DB, loc, id),
  ]);

  // Zero-fill so the axis is continuous: a month with no spending is a real data point, and a gap
  // would make the line jump between distant months as though they were adjacent.
  const byMonth = new Map(trend.map((r) => [r.month, r.spent]));
  const months: { month: string; spent: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const key = stats.localYm(stats.localMonthStart(to, -i));
    months.push({ month: key, spent: byMonth.get(key) ?? 0 });
  }

  const lv = levels.get(id);
  const b = budgets.find((x) => x.id === id);
  return c.json({
    id, name: localizeCatName(loc, row.name), color: row.color,
    importance: row.importance ?? "discretionary",
    children,
    level: lv ? { level: lv.level, mean: lv.mean, last: lv.last, active_months: lv.active_months, fixed: lv.fixed } : null,
    trend: months,
    budget: b ? { amount: b.amount, spent: b.spent, projected: b.projected, lumpy: b.lumpy } : null,
    recurring: split.recurring,
    oneoff: split.oneoff,
  } satisfies CategoryOverview);
});
