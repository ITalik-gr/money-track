// `/analytics/*` — the read-only reporting surface. Every number here comes from the canon
// (`lib/finance/stats.ts` on the JS side, `repo/analytics.ts` on the SQL side); a handler that
// starts computing its own total is the §CUR-PLAN mechanism restarting.
import {
  getPeriodMode, valueMode, baseMult, periodBounds,
  recurringOneoffSplit, defaultRefFrom, isRecurringExpr, projectSpend, categoryMonthlyLevels, localMonthStart, localYm, localYmd, localParts,
  type Preset,
} from "../../lib/finance/stats.ts";
import { computeSummary } from "../../lib/finance/finance.ts";
import { getRates } from "../../lib/finance/money.ts";
import * as analyticsRepo from "../../repo/analytics.ts";
import * as planningRepo from "../../repo/planning.ts";
import * as receiptsRepo from "../../repo/receipts.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes } from "./_shared.ts";
import { buildWeekdayAnalytics } from "../../lib/finance/weekday.ts";
import { buildNetworth } from "../../lib/finance/networth.ts";
import { collectHabits } from "../../lib/finance/habits.ts";
import { collectMonthlyHistory } from "../../lib/finance/history.ts";
import type {
  Overview, MonthlyHistory, SafeToSpend, CapitalTrend, Networth, Compare, Forecast,
  IncomeAnalytics, CashflowCalendar, ReceiptItemsAnalytics, PriceDrift, SpendPatterns,
  CategoryDrill, SliceDrill, MerchantAnalytics, SparkData, FinanceHealth, CategorySpend,
  CurrenciesList, WeekdayAnalytics, Habits,
} from "../../../shared/api/index.ts";

export const analytics = apiRoutes();

// ---- analytics --------------------------------------------------------------

// Aggregated analytics for the stats page: totals + prev-period comparison, a time
// series, and breakdowns by category / merchant / account. Per-currency (§5),
// transfers excluded. One call to keep the page snappy.
analytics.get("/analytics/overview", async (c) => {
  const url = new URL(c.req.url);
  const rates = await getRates(c.env);
  const mode = await getPeriodMode(c.env.DB);
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

  const db = c.env.DB, v = { mult, curFilter }, loc = c.get("locale");
  const cur_ = { from, to }, prev_ = { from: prevFrom, to: prevTo };

  const [summary, prev, series, byCategory, byMerchant, byAccount, byEvent, byImportance] = await Promise.all([
    analyticsRepo.periodTotals(db, v, cur_),
    analyticsRepo.periodTotals(db, v, prev_),
    analyticsRepo.series(db, v, cur_, fmt),
    analyticsRepo.spendByCategory(db, loc, v, cur_),
    analyticsRepo.spendByMerchant(db, v, cur_),
    analyticsRepo.spendByAccount(db, v, cur_),
    analyticsRepo.spendByEvent(db, v, cur_),
    analyticsRepo.spendByImportance(db, v, cur_),
  ]);

  return c.json({
    summary, prev,
    range: { from, to, prevFrom, prevTo, bucket, mode, preset: presetParam ?? null },
    series, byCategory, byMerchant, byAccount, byEvent, byImportance,
  } satisfies Overview);
});

// Довготривала історія по МІСЯЦЯХ (канонічно, зведено в ₴): spend/income за N останніх
// місяців. Доповнює періодні вкладки Статистики довгим трендом (6-12 міс) для графіка
// «витрати/надходження/чистий» і норми заощаджень. Останній місяць — поточний (частковий).
analytics.get("/analytics/monthly-history", async (c) => {
  const months = Math.min(24, Math.max(3, Number(new URL(c.req.url).searchParams.get("months") ?? 6)));
  return c.json(await collectMonthlyHistory(c.env, months) satisfies MonthlyHistory);
});

// §4 Safe-to-spend: скільки вільно до кінця календарного місяця. Розрахунок — `lib/finance/
// cashflow.ts` `safeToSpend` (винесено під C3): роут дає лише «зараз».
analytics.get("/analytics/safe-to-spend", async (c) => {
  const rates = await getRates(c.env);
  const { mult } = valueMode(rates, null);
  const { safeToSpend } = await import("../../lib/finance/cashflow.ts");
  const now = Math.floor(Date.now() / 1000);
  return c.json(await safeToSpend(c.env, rates, mult, now) satisfies SafeToSpend);
});

// Тренд капіталу: динаміка власних коштів (₴) за N місяців. Історія не зберігається,
// тож реконструюємо назад від поточного тоталу: капітал(кінець дня d) = капітал_зараз
// − Σ(зміни балансу після дня d). Кожен рядок транзакції змінює баланс рахунку на amount
// (перекази між своїми — обидві ноги в таблиці, взаємно гасяться). Курси — поточні (апрокс).
analytics.get("/analytics/capital-trend", async (c) => {
  const url = new URL(c.req.url);
  const months = Math.min(Math.max(Number(url.searchParams.get("months") ?? 6), 1), 24);
  const rates = await getRates(c.env);
  const mult = baseMult(rates);
  const summary = await computeSummary(c.env);

  const now = Math.floor(Date.now() / 1000);
  const from = localMonthStart(now, -months + 1);

  // Денна чиста зміна капіталу (₴-копійки, знак збережено) від початку періоду.
  const daily = await analyticsRepo.dailyNetChange(c.env.DB, mult, from);
  const netByDay = new Map<number, number>();
  for (const r of daily) netByDay.set(r.day, r.net);

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
  return c.json({ now_uah: Math.round(summary.totalUAH / 100), points } satisfies CapitalTrend);
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
analytics.get("/analytics/networth", async (c) => {
  const url = new URL(c.req.url);
  const months = Math.min(Math.max(Number(url.searchParams.get("months") ?? 12), 2), 24);
  return c.json(await buildNetworth(c.env, months, c.get("locale")) satisfies Networth);
});

// §P3: сторінка мерчанта — агрегати по одному мерчанту (уся історія + тренд 6 міс + частка
// в категорії). Канон stats.ts (SPEND_WHERE/amountSum/EFF_*), зведено в ₴.
analytics.get("/analytics/merchant", async (c) => {
  const name = new URL(c.req.url).searchParams.get("name");
  if (!name) return c.json({ error: "name required" }, 400);
  const rates = await getRates(c.env);
  const { mult } = valueMode(rates, null);
  const now = Math.floor(Date.now() / 1000);
  const from6 = localMonthStart(now, -5);

  const db = c.env.DB, loc = c.get("locale");
  const [agg, byMonth, topCat, txs] = await Promise.all([
    analyticsRepo.merchantAggregate(db, mult, name),
    analyticsRepo.merchantByMonth(db, mult, now, name, from6),
    analyticsRepo.merchantTopCategory(db, loc, mult, name),
    analyticsRepo.merchantTransactions(db, loc, name),
  ]);

  // Частка в категорії: витрати мерчанта / витрати всієї категорії (уся історія).
  let categoryShare: number | null = null;
  if (topCat?.id != null && topCat.spent > 0) {
    const catTot = await analyticsRepo.categoryTotalAllTime(db, mult, topCat.id);
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
    by_month: byMonth.map((r) => ({ month: r.m, spent: r.spent })),
    top_category: topCat?.name ? { name: topCat.name, color: topCat.color, spent: topCat.spent } : null,
    category_share: categoryShare,
    transactions: txs,
  } satisfies MerchantAnalytics);
});

// Порівняння двох періодів side-by-side (беклог): вибраний період A проти попереднього
// рівного за довжиною B. Тотали + розбивка по категоріях (рол-ап підкатегорій), per-currency.
analytics.get("/analytics/compare", async (c) => {
  const url = new URL(c.req.url);
  const rates = await getRates(c.env);
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

  const db = c.env.DB, v = { mult, curFilter }, loc = c.get("locale");
  const totals = (f: number, t: number) => analyticsRepo.spendIncomeTotals(db, v, { from: f, to: t });
  const cats = (f: number, t: number) => analyticsRepo.compareByCategory(db, loc, v, { from: f, to: t });

  const [aTot, bTot, aCats, bCats] = await Promise.all([totals(from, to), totals(bFrom, bTo), cats(from, to), cats(bFrom, bTo)]);
  return c.json({
    a: { from, to, spend: aTot?.spend ?? 0, income: aTot?.income ?? 0, byCategory: aCats },
    b: { from: bFrom, to: bTo, spend: bTot?.spend ?? 0, income: bTot?.income ?? 0, byCategory: bCats },
  } satisfies Compare);
});

// Month-end forecast (§7): project this month's spend from the current daily pace
// plus known upcoming planned payments. UAH only, transfers excluded. No migration.
analytics.get("/analytics/forecast", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const monthStart = localMonthStart(now);
  const daysInMonth = Math.round((localMonthStart(now, 1) - monthStart) / 86400);
  const dayOfMonth = localParts(now).d; // 1..daysInMonth, у локальній зоні
  const daysElapsed = dayOfMonth;
  const daysRemaining = daysInMonth - dayOfMonth;

  const rates = await getRates(c.env);
  const { mult } = valueMode(rates, null); // forecast завжди зведено в ₴
  // Трейлінг: до 3 ПОВНИХ місяців перед поточним — для історичного якоря прогнозу.
  const trailStart = localMonthStart(now, -3);
  const [totals, trail] = await Promise.all([
    analyticsRepo.spendIncomeTotals(c.env.DB, { mult, curFilter: "" }, { from: monthStart, to: now }),
    analyticsRepo.monthlySpendBefore(c.env.DB, mult, now, trailStart, monthStart),
  ]);

  const spend = totals?.spend ?? 0;
  const income = totals?.income ?? 0;
  const pace = daysElapsed > 0 ? spend / daysElapsed : 0;
  // Прогноз місяця = блендимо наївний темп (роздуває рано в місяці) з історичним якорем
  // (факт + середньомісячна історія на дні, що лишились). Рано довіряємо історії, під кінець —
  // фактичному темпу. Без історії — падаємо на чистий темп.
  const trailMonths = trail.map((r) => r.spend);
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
  // §SUB-MONTH: розклад дає канонічний `chargesBetween` — тижневий план у залишку місяця
  // спишеться кілька разів, а власний однопрохідний цикл рахував рівно одне списання на план.
  const { chargesBetween } = await import("../../lib/finance/subscriptions.ts");
  const fxRates = await getRates(c.env);
  const planned = await planningRepo.activeWithTitles(c.env.DB);

  // §CUR-PLAN: суми зводимо в ₴ — вони йдуть в один ряд із витратами місяця (теж ₴).
  const monthEnd = localMonthStart(now, 1);
  const upcomingItems = chargesBetween(planned, fxRates, now + 1, monthEnd - 1)
    .map((ch) => ({ title: ch.plan.title, amount: ch.amount, at: ch.at }));
  const upcomingPlanned = upcomingItems.reduce((s, p) => s + p.amount, 0);

  /**
   * §INCOME-PLAN — THIS is where the asymmetry gets fixed.
   *
   * `projectedNet` used to be `income(month-to-date) − projectedSpend(end of month)`: a fact minus
   * a forecast, which is guaranteed to look catastrophic on the 3rd and to "improve" as the month
   * passes without anything actually changing. Both halves now describe the same instant — the end
   * of the month — so the number finally answers the question it is labelled with.
   * ⚠️ `projectedIncome` is reported SEPARATELY as well, so the reader can see which half of the
   * net is money in the bank and which half is a plan. A single net figure would hide exactly the
   * uncertainty the owner flagged: income is not always the same, and not always on time.
   */
  const { incomeOutlook } = await import("../../lib/finance/income.ts");
  const outlook = await incomeOutlook(c.env, now);
  const projectedIncome = income + outlook.expected_remaining;

  return c.json({
    monthStart, now, daysInMonth, daysElapsed, daysRemaining,
    spend, income, pace: Math.round(pace),
    projectedSpend, projectedLow, projectedHigh,
    projectedIncome,
    incomeExpected: outlook.expected_remaining,
    incomeOverdue: outlook.overdue,
    incomeEstimated: outlook.estimated,
    projectedNet: projectedIncome - projectedSpend,
    upcomingPlanned, upcomingItems,
  } satisfies Forecast);
});

// §1 Аналітика доходу: джерела (по ефективній категорії за період), стабільність
// (варіативність місячного доходу за 6 повних місяців) і дельта проти минулого періоду.
// Канонічно (INCOME_WHERE), зведено в ₴. Дзеркалить визначення Статистики.
analytics.get("/analytics/income", async (c) => {
  const url = new URL(c.req.url);
  const rates = await getRates(c.env);
  const mode = await getPeriodMode(c.env.DB);
  const presetParam = (url.searchParams.get("preset") as Preset | null) ?? "month";
  const preset: Preset = ["week", "month", "quarter", "year"].includes(presetParam) ? presetParam : "month";
  const { from, to, prevFrom, prevTo } = periodBounds(mode, preset);
  const cur = url.searchParams.get("currency") ? Number(url.searchParams.get("currency")) : null;
  const { mult, curFilter } = valueMode(rates, cur);

  const db = c.env.DB, v = { mult, curFilter };
  const nowS = Math.floor(Date.now() / 1000);

  const [sources, curTot, prevTot, monthly] = await Promise.all([
    analyticsRepo.incomeBySource(db, c.get("locale"), v, { from, to }),
    analyticsRepo.incomeTotal(db, v, { from, to }),
    analyticsRepo.incomeTotal(db, v, { from: prevFrom, to: prevTo }),
    // 6 календарних місяців для оцінки стабільності (по місяцях).
    analyticsRepo.monthlyIncome(db, v, nowS, { from: localMonthStart(nowS, -5), to: nowS }),
  ]);

  const total = curTot?.income ?? 0;
  const prevTotal = prevTot?.income ?? 0;
  const deltaPct = prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 100) : (total > 0 ? null : 0);

  const srcRows = sources.map((s) => ({
    category_id: s.category_id, name: s.name ?? st(c.get("locale"), "other"), color: s.color,
    amount: s.amount, n: s.n, pct: total > 0 ? Math.round((s.amount / total) * 100) : 0,
  }));

  // Стабільність: коеф. варіації (stddev/mean) по ПОВНИХ місяцях (без поточного часткового).
  const nowMonth = new Date().toISOString().slice(0, 7);
  const complete = monthly.filter((r) => r.m !== nowMonth).map((r) => r.income);
  let cvPct: number | null = null, label = st(c.get("locale"), "stabilityUnknown");
  if (complete.length >= 2) {
    const mean = complete.reduce((a, b) => a + b, 0) / complete.length;
    if (mean > 0) {
      const variance = complete.reduce((a, b) => a + (b - mean) ** 2, 0) / complete.length;
      cvPct = Math.round((Math.sqrt(variance) / mean) * 100);
      label = st(c.get("locale"), cvPct <= 15 ? "stabilityStable" : cvPct <= 40 ? "stabilityModerate" : "stabilityVolatile");
    }
  }

  return c.json({
    period: { from, to, preset },
    total, prev_total: prevTotal, delta_pct: deltaPct,
    sources: srcRows,
    monthly: monthly.map((r) => ({ month: r.m, income: r.income })),
    stability: { cv_pct: cvPct, label },
  } satisfies IncomeAnalytics);
});

// Cashflow-календар: ВСІ очікувані рухи по днях у вікні [from,to] (на відміну від
// /planned/upcoming — той дає лише наступне списання на план). + стартова ліквідна подушка для
// проєкції балансу «наперед» → видно провали ліквідності.
//
// §INCOME-PLAN: більше НЕ аутфлоу-only. Доти проєкція балансу вміла лише падати, тож «провал
// ліквідності» був гарантованим для будь-кого, чия зарплата приходить пізніше за оренду — календар
// оголошував діру, яку закривали гроші, про які він не знав. Надходження приходять ДОДАТНІМИ
// сумами тим самим `chargesBetween`, тож послідовність днів лишається одним рядом чисел.
analytics.get("/analytics/cashflow-calendar", async (c) => {
  const url = new URL(c.req.url);
  const now = Math.floor(Date.now() / 1000);
  const from = Number(url.searchParams.get("from") ?? localMonthStart(now));
  const to = Number(url.searchParams.get("to") ?? localMonthStart(now, 2) - 1);

  const { cashflowMoves } = await import("../../lib/finance/cashflow.ts");
  const { fundsBreakdown } = await import("../../lib/ai/advisor.ts");
  const [funds, rates] = await Promise.all([fundsBreakdown(c.env), getRates(c.env)]);
  const items = await cashflowMoves(c.env.DB, rates, from, to);

  return c.json({ from, to, now, cushion: funds.cushion, items } satisfies CashflowCalendar);
});

// Аналітика позицій чека (receipt_items з OCR): топ товарів за сумою за період.
// price — копійки за рядок; групуємо за нормалізованою назвою. Показуємо, лише якщо є чеки.
analytics.get("/analytics/receipt-items", async (c) => {
  const url = new URL(c.req.url);
  const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(url.searchParams.get("from") ?? to - 90 * 86400);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 15), 1), 50);

  // Дата позиції = purchased_at чека (fallback created_at). Тільки чеки в періоді.
  const [rows, meta] = await Promise.all([
    receiptsRepo.topItems(c.env.DB, from, to, limit),
    receiptsRepo.windowMeta(c.env.DB, from, to),
  ]);

  return c.json({ items: rows, receipts: meta?.receipts ?? 0, total_items: meta?.items ?? 0 } satisfies ReceiptItemsAnalytics);
});

// §E4: дрейф цін / персональна інфляція. Для кожної позиції чека (нормалізована назва)
// беремо ЮНІТ-ціну (price/qty) в кожній покупці; якщо позиція трапилась ≥3 разів із
// достатнім розкидом у часі — порівнюємо середню юніт-ціну ранньої половини покупок із
// пізньою → % зміни. Індекс кошика = медіана змін по позиціях. Детерміновано, без AI.
analytics.get("/analytics/price-drift", async (c) => {
  const url = new URL(c.req.url);
  const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(url.searchParams.get("from") ?? to - 180 * 86400);
  const MIN_N = 3, MIN_SPAN = 21 * 86400, NOISE = 5;

  const rows = await receiptsRepo.pricePoints(c.env.DB, from, to);

  const byName = new Map<string, { at: number; unit: number }[]>();
  for (const r of rows) {
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

  return c.json({ window: { from, to }, basket_change_pct: basket != null ? Math.round(basket * 10) / 10 : null, tracked: items.length, items: movers } satisfies PriceDrift);
});

// §E1/E2/E3: патерни витрат ЦЬОГО МІСЯЦЯ — усе детерміновано, без AI.
//  • recurring: разові vs регулярні (канон stats.ts) + топ разових;
//  • anomalies: категорії, чий прогноз на кінець місяця значно вищий за звичний (трейлінг 6 міс);
//  • pace: темп по топ-категоріях — факт (MTD) vs звичний місяць vs лінійний прогноз.
analytics.get("/analytics/patterns", async (c) => {
  const rates = await getRates(c.env);
  const { mult } = valueMode(rates, null);
  const now = Math.floor(Date.now() / 1000);
  const monthStart = localMonthStart(now);
  const nextMonthStart = localMonthStart(now, 1);
  const elapsedFrac = Math.min(1, Math.max(0.02, (now - monthStart) / (nextMonthStart - monthStart)));
  const curKey = new Date(now * 1000).toISOString().slice(0, 7);
  // Трейлінг-вікно: 6 повних місяців перед поточним.
  const refStart = localMonthStart(now, -6);
  const trailingKeys: string[] = [];
  for (let i = 6; i >= 1; i--) trailingKeys.push(localYm(localMonthStart(now, -i)));

  const recurExpr = isRecurringExpr(defaultRefFrom(now), now);
  const levels = await categoryMonthlyLevels(c.env, mult, { now }); // канонічний «місячний рівень»
  const [matrix, split, curSplit] = await Promise.all([
    analyticsRepo.categoryMonthMatrix(c.env.DB, c.get("locale"), mult, now, { from: refStart, to: now }),
    recurringOneoffSplit(c.env, monthStart, now, mult, defaultRefFrom(now)),
    // Поточний місяць по категоріях, розділений на регулярне/разове + сигнали лумпності
    // (n — к-ть операцій, biggest — найбільша одна) для чесного прогнозу.
    analyticsRepo.currentMonthSplitByCategory(c.env.DB, mult, recurExpr, { from: monthStart, to: now }),
  ]);
  const curSplitMap = new Map<string, { recurring: number; oneoff: number; n: number; biggest: number }>();
  for (const r of curSplit) curSplitMap.set(String(r.id ?? "null"), { recurring: r.recurring, oneoff: r.oneoff, n: r.n, biggest: r.biggest });

  interface Cat { id: number | null; name: string; color: string | null; months: Map<string, number> }
  const cats = new Map<string, Cat>();
  for (const r of matrix) {
    const key = String(r.id ?? "null");
    let cat = cats.get(key);
    if (!cat) { cat = { id: r.id, name: r.name ?? st(c.get("locale"), "uncategorized"), color: r.color, months: new Map() }; cats.set(key, cat); }
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
  } satisfies SpendPatterns);
});

// Drill-down однієї (батьківської) категорії за період: розбивка по підкатегоріях +
// топ-мерчанти всередині. Для «відкрити велику категорію й глянути детальніше» (§F5).
analytics.get("/analytics/category", async (c) => {
  const url = new URL(c.req.url);
  const category = Number(url.searchParams.get("category"));
  const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(url.searchParams.get("from") ?? to - 30 * 86400);
  const rates = await getRates(c.env);
  const cur = url.searchParams.get("currency") ? Number(url.searchParams.get("currency")) : null;
  const { mult, curFilter } = valueMode(rates, cur);

  // §CAT-PAGE: the scope (sub-category? income?) is resolved inside `categoryDrill`, next to the
  // queries that depend on it — see that file for why it must not live at the call site.
  const { categoryDrill } = await import("../../lib/finance/category-drill.ts");
  const drill = await categoryDrill(
    c.env.DB, c.get("locale"), { mult, curFilter }, { from, to }, category,
  );
  return c.json(drill satisfies CategoryDrill);
});

// §R2-ST5(б): drill будь-якого зрізу (мерчант / картка / група) — підсумок + самі
// операції з переходом на /tx/:id. dim = merchant | account | event.
analytics.get("/analytics/slice", async (c) => {
  const url = new URL(c.req.url);
  const dim = url.searchParams.get("dim") ?? "merchant"; // merchant|account|event|weekday|day|all
  const type = url.searchParams.get("type") === "income" ? "income" : "expense";
  const value = url.searchParams.get("value") ?? "";
  const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(url.searchParams.get("from") ?? to - 30 * 86400);
  const rates = await getRates(c.env);
  const cur = url.searchParams.get("currency") ? Number(url.searchParams.get("currency")) : null;
  const { mult, curFilter } = valueMode(rates, cur);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 300);

  const v = { mult, curFilter };
  const range = { from, to };
  const q = { dim, type, value, limit } as const;

  const [summary, txs] = await Promise.all([
    analyticsRepo.sliceSummary(c.env.DB, v, range, q),
    analyticsRepo.sliceTransactions(c.env.DB, c.get("locale"), v, range, q),
  ]);
  // Для доходу сума виходить від'ємною (amountSum рахує -amount) — віддаємо абсолют.
  const spent = Math.abs(summary?.spent ?? 0);
  return c.json({ spent, n: summary?.n ?? 0, transactions: txs } satisfies SliceDrill);
});

// Which currencies actually have transactions (for the stats currency switch).
analytics.get("/analytics/currencies", async (c) => {
  return c.json(await analyticsRepo.distinctCurrencies(c.env.DB) satisfies CurrenciesList);
});

// Spend by effective category for a period, зведено в ₴ (канонічно).
analytics.get("/analytics/by-category", async (c) => {
  const url = new URL(c.req.url);
  const from = Number(url.searchParams.get("from") ?? 0);
  const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
  const rates = await getRates(c.env);
  const { mult } = valueMode(rates, null);
  // Той самий запит, що живить `byCategory` в /analytics/overview — без валютного фільтра.
  return c.json(await analyticsRepo.spendByCategory(
    c.env.DB, c.get("locale"), { mult, curFilter: "" }, { from, to }) satisfies CategorySpend[]);
});


// §WEEKDAY: куди йдуть гроші за днями тижня. Питання, на яке решта Статистики не відповідає:
// вона показує СКІЛЬКИ і НА ЩО, але не КОЛИ — а «пʼятниця коштує як три вівторки» це те, що
// людина може змінити поведінкою, не відмовляючись ні від чого.
//
// Ділимо на кількість таких днів у вікні (`weekdayCounts`) — інакше порівняння бреше: у місяці
// пʼятниць 5, а субот 4. Саме тому `typical` рахує СЕРВЕР: якби ділив клієнт, AI-контекст і
// екран отримали б два різні числа про одне й те саме.
analytics.get("/analytics/weekday", async (c) => {
  const url = new URL(c.req.url);
  const rates = await getRates(c.env);
  const mode = await getPeriodMode(c.env.DB);
  const presetParam = url.searchParams.get("preset") as Preset | null;
  const now = Math.floor(Date.now() / 1000);

  let from: number, to: number;
  if (presetParam && ["week", "month", "quarter", "year"].includes(presetParam)) {
    ({ from, to } = periodBounds(mode, presetParam, now));
  } else {
    to = Number(url.searchParams.get("to") ?? now);
    from = Number(url.searchParams.get("from") ?? to - 90 * 86400);
  }

  const curParam = url.searchParams.get("currency");
  const { mult, curFilter } = valueMode(rates, curParam ? Number(curParam) : null);
  const rows = await analyticsRepo.spendByWeekday(c.env.DB, { mult, curFilter }, { from, to }, now);

  return c.json(buildWeekdayAnalytics(rows, from, to) satisfies WeekdayAnalytics);
});

// §HABITS — the assembly lives in the feature file (`lib/finance/habits.ts`); this is transport
// only. The extraction was forced by lint C3, and it is exactly the case the lint exists for: the
// window, the canon conversion and excluding already-known merchants are feature logic, not a
// route's job.
analytics.get("/analytics/habits", async (c) => {
  return c.json(await collectHabits(c.env, Math.floor(Date.now() / 1000)) satisfies Habits);
});

// Спарклайни: 6-міс місячні витрати на КАТЕГОРІЮ й на МЕРЧАНТА (канон stats.ts, зведено в ₴).
// Мапа {ключ: [6 значень копійок]} + буксети-місяці. Клієнт малює міні-тренд у рядках списків.
analytics.get("/analytics/spark", async (c) => {
  const N = 6;
  const now = Math.floor(Date.now() / 1000);
  const from = localMonthStart(now, -(N - 1));
  const buckets: string[] = [];
  for (let i = N - 1; i >= 0; i--) buckets.push(localYm(localMonthStart(now, -i)));
  const bIdx = new Map(buckets.map((b, i) => [b, i]));
  const { mult } = valueMode(await getRates(c.env), null);
  const [cat, mer] = await Promise.all([
    analyticsRepo.categoryMonthSeries(c.env.DB, mult, now, from),
    analyticsRepo.merchantMonthSeries(c.env.DB, mult, now, from),
  ]);
  const categories: Record<string, number[]> = {};
  for (const r of cat) {
    if (r.id == null) continue;
    const arr = (categories[String(r.id)] ??= buckets.map(() => 0));
    const i = bIdx.get(r.m); if (i != null) arr[i] = Math.round(r.spent);
  }
  const merchants: Record<string, number[]> = {};
  for (const r of mer) {
    const arr = (merchants[r.name] ??= buckets.map(() => 0));
    const i = bIdx.get(r.m); if (i != null) arr[i] = Math.round(r.spent);
  }
  return c.json({ buckets, categories, merchants } satisfies SparkData);
});

// §H: детермінований Індекс фінздоров'я (без AI) + запис скору за добу для тренду в часі.
analytics.get("/analytics/health", async (c) => {
  const { financeHealth } = await import("../../lib/ai/advisor.ts");
  const h = await financeHealth(c.env);
  const now = Math.floor(Date.now() / 1000);
  // §APP_TZ: доба — київська. Скор пишеться при кожному відкритті сторінки, тож із UTC-ключем
  // вечірній перегляд і нічний писали В ОДИН рядок, а `draftHealthDrop` (стрічка сповіщень)
  // порівнює саме ці рядки — просідання «за 5 днів» рахувалось по зсунутій сітці днів.
  const day = localYmd(now);
  try {
    await analyticsRepo.recordHealthScore(c.env.DB, day, h.score, now);
    const trend = await analyticsRepo.healthTrend(c.env.DB, localYmd(now - 45 * 86400));
    return c.json({ ...h, trend } satisfies FinanceHealth);
  } catch {
    return c.json({ ...h, trend: [] } satisfies FinanceHealth); // таблиця може лагати на remote до міграції
  }
});
