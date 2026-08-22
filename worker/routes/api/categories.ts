// `/categories/*` — the category tree. The delete is a CASCADE and its step ORDER is the
// behaviour: the harness enforces foreign keys, so a step moved after the row is deleted fails.
import * as categoriesRepo from "../../repo/categories.ts";
import * as budgetsRepo from "../../repo/budgets.ts";
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

  const { getRates, uahToBase } = await import("../../lib/finance/money.ts");
  const stats = await import("../../lib/finance/stats.ts");
  const { budgetStatus } = await import("../../lib/finance/budgets.ts");
  const rates = await getRates(c.env);
  const { mult } = stats.valueMode(rates, null);
  const uahRate = uahToBase(rates);
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
  // 365 days, not «the same month number»: the window the reader picked may be a quarter or a
  // year, and «one year earlier» has to mean the same LENGTH of time shifted back, or the two
  // halves of the comparison stop being comparable.
  const YEAR = 365 * 86400;

  const row = await categoriesRepo.byId(c.env.DB, id);
  if (!row) return c.json({ error: "not_found" }, 404);

  /**
   * §CAT-PAGE — the scope, decided ONCE and handed to every query below.
   *
   * Two live bugs came from not having it. A sub-category never matches `EFF_CAT_ID` (that rolls
   * up to the parent), so every sub-category page was blank — and the parent page links straight
   * to it. And an income bucket has no spending at all, so "Зарплата" was zeros on a page built
   * out of `SPEND_WHERE`.
   */
  const scope = {
    id,
    isParent: row.parent_id == null,
    isIncome: !!row.is_income,
  };

  // 24 months, not 12: the owner asked to see the whole history, and a year is exactly the window
  // in which a yearly rhythm (insurance, tuition, holidays) is invisible — it appears once and
  // looks like a one-off.
  const TREND_MONTHS = 24;

  const [levels, budgets, trend, split, children, parts, closed, lifetime, merchants, cur, yearAgo, prevWin] = await Promise.all([
    stats.categoryMonthlyLevels(c.env, mult, { now: to }),
    budgetStatus(c.env, mult, now),
    categoriesRepo.monthlyTrend(c.env.DB, mult, scope, stats.localMonthStart(to, -(TREND_MONTHS - 1)), to),
    categoriesRepo.recurringSplit(c.env.DB, mult, scope, from, to, stats.isRecurringExpr(stats.defaultRefFrom(to), to)),
    categoriesRepo.childrenOf(c.env.DB, loc, id),
    // What the category is MADE of, in the chosen window. Only for a parent: a leaf has no parts,
    // and asking would return one bucket equal to the total — a chart of itself.
    row.parent_id == null
      ? categoriesRepo.childrenBreakdown(c.env.DB, mult, { id, isParent: true, isIncome: !!row.is_income }, from, to)
      : Promise.resolve([]),
    // §BUDGET-MEMORY. NOT derived from `trend` above: that is what was SPENT, and whether a month
    // was closed inside its envelope also depends on the limit that was in force at the time —
    // which exists nowhere except this row. Comparing today's limit against last spring's spending
    // would be a verdict the data cannot support.
    budgetsRepo.monthsForCategory(c.env.DB, id, 6),
    // §CAT-PAGE: independent of the window, so an empty PERIOD can never look like an empty
    // CATEGORY — the exact confusion the owner reported.
    categoriesRepo.lifetimeStats(c.env.DB, mult, scope),
    categoriesRepo.lifetimeMerchants(c.env.DB, mult, scope, 8),
    // The window itself, the SAME window a year back, and the one immediately before it. Three
    // identical queries rather than one clever one: the windows differ only in their bounds, and
    // an expression that derived them from each other would have to encode which is which.
    categoriesRepo.windowStats(c.env.DB, mult, scope, from, to),
    categoriesRepo.windowStats(c.env.DB, mult, scope, from - YEAR, to - YEAR),
    categoriesRepo.windowStats(c.env.DB, mult, scope, from - (to - from), from - 1),
  ]);

  // Zero-fill so the axis is continuous: a month with no spending is a real data point, and a gap
  // would make the line jump between distant months as though they were adjacent.
  //
  // ⚠️ But only from the FIRST month this category ever had (2026-08-21). A zero before that is
  // not «nothing was spent», it is «this account did not exist yet» — and 24 of them is what the
  // owner saw: a chart that is mostly an empty floor, where every hover reads 0. Zero-filling
  // pre-history states something about a period nobody lived through.
  const byMonth = new Map(trend.map((r) => [r.month, r.spent]));
  const firstYm = lifetime.first_at ? stats.localYm(lifetime.first_at) : null;
  const months: { month: string; spent: number }[] = [];
  for (let i = TREND_MONTHS - 1; i >= 0; i--) {
    const key = stats.localYm(stats.localMonthStart(to, -i));
    if (firstYm && key < firstYm) continue;   // `YYYY-MM` sorts as text — see `localYm`
    months.push({ month: key, spent: byMonth.get(key) ?? 0 });
  }

  /**
   * The canonical monthly LEVEL is spend-only and rolls up (`categoryMonthlyLevels`), so it applies
   * to exactly one case: a top-level expense category. For a sub-category or an income bucket it
   * would be a number about a DIFFERENT category, which is worse than none — so it is null there,
   * and the lifetime average below carries the "how much a month" question instead.
   */
  const lv = scope.isParent && !scope.isIncome ? levels.get(id) : undefined;
  /**
   * Likewise the envelope: budgets live on top-level expense categories, and `budgetStatus` is
   * month-to-date by definition. Showing it beside a window the reader widened to a year would put
   * two different periods in one response — the §CATEGORY-PAGE bug fixed once already.
   */
  const isThisMonth = from === stats.localMonthStart(now) && to >= now - 86400;
  const b = scope.isParent && !scope.isIncome && isThisMonth
    ? budgets.find((x) => x.id === id)
    : undefined;
  return c.json({
    id, name: localizeCatName(loc, row.name), color: row.color,
    importance: row.importance ?? "discretionary",
    is_income: scope.isIncome,
    is_sub: !scope.isParent,
    children,
    /**
     * §CAT-PAGE — «з чого складається ця категорія», in the selected window.
     *
     * The chips above name the sub-categories; this says how much each one IS. A parent's total is
     * a roll-up by construction, so the number the page leads with is precisely the one that hides
     * the answer to «що саме виросло».
     *
     * ⚠️ The parent's OWN rows are a part like any other (`self: true`), not a remainder folded
     * away: «40% Транспорту не розкладено» is a finding about how the ledger is kept, and it is
     * invisible in a list of children alone. Sorted by size, so the answer is the first line.
     */
    composition: (() => {
      const named = new Map(children.map((ch) => [ch.id, ch]));
      const total = parts.reduce((sum, p) => sum + Math.abs(p.spent), 0);
      return parts
        .filter((p) => p.spent !== 0)
        .map((p) => {
          const ch = named.get(p.leaf);
          return {
            id: p.leaf,
            // A leaf that is the category itself is not a child and has no row in `children`.
            name: ch ? ch.name : localizeCatName(loc, row.name),
            color: ch ? ch.color : row.color,
            self: !ch,
            spent: Math.abs(p.spent),
            n: p.n,
            share_pct: total > 0 ? Math.round((Math.abs(p.spent) / total) * 100) : 0,
          };
        });
    })(),
    lifetime: {
      total: lifetime.total, n: lifetime.n,
      first_at: lifetime.first_at, last_at: lifetime.last_at,
      active_months: lifetime.months,
      // The honest "per month": total over the months that actually had activity, NOT over the
      // calendar span. A category used twice a year would otherwise report a monthly figure it has
      // never once spent.
      per_active_month: lifetime.months > 0 ? Math.round(lifetime.total / lifetime.months) : 0,
    },
    /**
     * Who this category IS — with each merchant's SHARE of it, not just its total.
     *
     * The list has been here since §CAT-PAGE and said only «Сільпо 42 000 ₴», which is a figure
     * the reader cannot act on without first knowing what the category costs. The share is the
     * part that makes it a finding: «70% Продуктів — це один магазин» names where a change would
     * actually land, and «жоден мерчант не більше 12%» says just as clearly that there is nothing
     * to consolidate here.
     *
     * ⚠️ Against the LIFETIME total, the same denominator the rows come from — mixing a window
     * total with lifetime rows would produce shares that do not add up to anything, and could
     * exceed 100%.
     */
    top_merchants: merchants.map((m) => ({
      ...m,
      share_pct: lifetime.total > 0 ? Math.round((Math.abs(m.spent) / lifetime.total) * 100) : 0,
    })),
    level: lv ? { level: lv.level, mean: lv.mean, last: lv.last, active_months: lv.active_months, fixed: lv.fixed } : null,
    trend: months,
    budget: b
      ? {
        amount: b.amount, base_amount: b.base_amount, carried: b.carried, rollover: b.rollover,
        spent: b.spent, projected: b.projected, lumpy: b.lumpy,
      }
      : null,
    // §BASE-CUR: `budget_months` is an ARCHIVE and is deliberately written in hryvnia, so it has
    // to be converted here like every other stored figure — this strip sits directly under the
    // envelope above, which `budgetStatus` already converts. Un-converted, the two halves of one
    // card were in different currencies. `currency-sweep.test.ts` cannot catch this one: the
    // fixture has no closed months, so the field is absent and a missing field cannot leak.
    budget_history: closed.map((m) => ({
      month: m.ym,
      limit: Math.round((m.limit_minor + m.carry_in_minor) * uahRate),
      spent: Math.round(m.spent_minor * uahRate),
    })),
    recurring: split.recurring,
    oneoff: split.oneoff,
    /**
     * ⚠️ `null` rather than a zero row when the comparison window predates the account.
     *
     * `lifetime.first_at` is the earliest transaction there has ever been; a window that ends
     * before it contained no data because there WAS none, and reporting «−100%» about a period
     * that did not exist is the same class of lie as `budget_history` claiming a month closed
     * under a limit that was never set.
     */
    year_ago: lifetime.first_at != null && to - YEAR >= lifetime.first_at
      ? { spent: yearAgo.spent, n: yearAgo.n }
      : null,
    avg_check: cur.n > 0
      ? {
        now: Math.round(cur.spent / cur.n),
        prev: prevWin.n > 0 ? Math.round(prevWin.spent / prevWin.n) : null,
        n: cur.n,
        prev_n: prevWin.n,
      }
      : null,
  } satisfies CategoryOverview);
});
