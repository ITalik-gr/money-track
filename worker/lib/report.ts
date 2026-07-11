// §Аналітика 2.0 — генератор періодичних AI-репортів (Sonnet 5). Збирає КАНОНІЧНИЙ
// контекст (ті самі визначення, що й Статистика/UI), порівнює з тим самим попереднім
// періодом, тягне аномалії (подорожчання підписок, викиди) і описи операцій (user_note),
// кличе Sonnet 5, зберігає структурований репорт у ai_reports. Ідемпотентно по періоду.
import type { Env } from "../env.ts";
import { getRates } from "./finance.ts";
import { fundsBreakdown } from "./advisor.ts";
import {
  STATS_JOINS, EFF_CAT_ID, EFF_CAT_NAME, EFF_IMPORTANCE, SPEND_WHERE, valueMode, spendSum, incomeSum, amountSum,
  lastCompletePeriod, currentPeriodToDate, recurringOneoffSplit,
} from "./stats.ts";
import { plannedActuals } from "./subscriptions.ts";
import { getState } from "./repo.ts";
import { generateFinancialReport, logUsage, getTaskModel, callCostUsd } from "./ai.ts";

export type ReportType = "week" | "month";
// last = завершений період (крон); current = поточний до сьогодні (ручна генерація/тест).
export type ReportScope = "last" | "current";

interface CatRow { id: number | null; name: string | null; spent: number }

// Розбивка по ефективній категорії (канонічно, зведено в ₴).
async function cats(env: Env, from: number, to: number, mult: string): Promise<CatRow[]> {
  const r = await env.DB.prepare(
    `SELECT ${EFF_CAT_ID} AS id, ${EFF_CAT_NAME} AS name, ${amountSum(mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
     GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC LIMIT 14`,
  ).bind(from, to).all<CatRow>();
  return r.results ?? [];
}

async function totals(env: Env, from: number, to: number, mult: string): Promise<{ spend: number; income: number }> {
  const r = await env.DB.prepare(
    `SELECT ${spendSum(mult)} AS spend, ${incomeSum(mult)} AS income
     FROM transactions t ${STATS_JOINS} WHERE t.time >= ? AND t.time <= ?`,
  ).bind(from, to).first<{ spend: number; income: number }>();
  return { spend: r?.spend ?? 0, income: r?.income ?? 0 };
}

// §6 Вагомість: частка обов'язкових/бажаних/необов'язкових витрат (канонічно, зведено в ₴).
async function importance(env: Env, from: number, to: number, mult: string): Promise<Record<string, number>> {
  const r = await env.DB.prepare(
    `SELECT ${EFF_IMPORTANCE} AS importance, ${amountSum(mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
     GROUP BY ${EFF_IMPORTANCE}`,
  ).bind(from, to).all<{ importance: string; spent: number }>();
  const out: Record<string, number> = {};
  for (const row of r.results ?? []) out[row.importance] = row.spent;
  return out;
}

// Зібрати весь контекст для AI (усі суми — ₴-копійки; в payload віддаємо в гривнях).
export interface TrendPoint { month: string; spend_uah: number; income_uah: number }
// §6: детермінована розбивка вагомості для рендеру на сторінці репорту (зберігається в data_json).
export interface ImportancePoint { level: string; amount_uah: number; pct: number }

export async function buildReportContext(env: Env, type: ReportType, scope: ReportScope = "last"): Promise<{
  period: { type: ReportType; scope: ReportScope; from: number; to: number };
  context: unknown;
  trend: TrendPoint[];
  importance: ImportancePoint[];
}> {
  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null);
  const { from, to, prevFrom, prevTo } = scope === "current" ? currentPeriodToDate(type) : lastCompletePeriod(type);
  const periodDays = Math.max(1, Math.round((to - from) / 86400));

  const [cur, prev, curCats, prevCats, merchants, notable, big, funds, actuals, imp, split, profile] = await Promise.all([
    totals(env, from, to, mult),
    totals(env, prevFrom, prevTo, mult),
    cats(env, from, to, mult),
    cats(env, prevFrom, prevTo, mult),
    env.DB.prepare(
      `SELECT t.merchant AS merchant, ${amountSum(mult)} AS spent, COUNT(*) AS n
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE} AND t.merchant IS NOT NULL
       GROUP BY t.merchant ORDER BY spent DESC LIMIT 10`,
    ).bind(from, to).all<{ merchant: string; spent: number; n: number }>(),
    // Помітні операції з описом користувача — щоб AI не плутав разове з регулярним.
    env.DB.prepare(
      `SELECT t.id AS id, t.merchant AS merchant, t.user_note AS note, ${EFF_CAT_NAME} AS category,
              CAST(ROUND((-t.amount) * ${mult}) AS INTEGER) AS amount
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE} AND t.user_note IS NOT NULL AND t.user_note <> ''
       ORDER BY amount DESC LIMIT 15`,
    ).bind(from, to).all<{ id: string; merchant: string | null; note: string; category: string | null; amount: number }>(),
    // Найбільші разові витрати (кандидати в аномалії).
    env.DB.prepare(
      `SELECT t.id AS id, t.merchant AS merchant, ${EFF_CAT_NAME} AS category,
              CAST(ROUND((-t.amount) * ${mult}) AS INTEGER) AS amount
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
       ORDER BY amount DESC LIMIT 6`,
    ).bind(from, to).all<{ id: string; merchant: string | null; category: string | null; amount: number }>(),
    fundsBreakdown(env),
    plannedActuals(env.DB),
    importance(env, from, to, mult),
    recurringOneoffSplit(env, from, to, mult),
    getState(env.DB, "finance_profile"),
  ]);

  const money = (minor: number) => Math.round(minor / 100);

  // §6: розбивка вагомості (сортована essential→discretionary→optional) для рендеру + AI.
  const IMP_ORDER = ["essential", "discretionary", "optional"];
  const impTotal = Object.values(imp).reduce((s, v) => s + v, 0);
  const importanceBreakdown: ImportancePoint[] = IMP_ORDER
    .filter((lv) => (imp[lv] ?? 0) > 0)
    .map((lv) => ({ level: lv, amount_uah: money(imp[lv]), pct: impTotal > 0 ? Math.round((imp[lv] / impTotal) * 100) : 0 }));

  // §5: тренд 6 місяців (spend/income по місяцях) — для лінії на сторінці репорту.
  const dTo = new Date(to * 1000);
  const trendFrom = Math.floor(new Date(dTo.getFullYear(), dTo.getMonth() - 5, 1).getTime() / 1000);
  const trendRows = await env.DB.prepare(
    `SELECT strftime('%Y-%m', t.time, 'unixepoch') AS m, ${spendSum(mult)} AS spend, ${incomeSum(mult)} AS income
     FROM transactions t ${STATS_JOINS} WHERE t.time >= ? AND t.time <= ? GROUP BY m ORDER BY m`,
  ).bind(trendFrom, to).all<{ m: string; spend: number; income: number }>();
  const trend: TrendPoint[] = (trendRows.results ?? []).map((r) => ({ month: r.m, spend_uah: money(r.spend), income_uah: money(r.income) }));

  const prevMap = new Map(prevCats.map((c) => [c.id, c.spent]));
  const categories = curCats.map((c) => {
    const p = prevMap.get(c.id) ?? 0;
    const delta = p > 0 ? Math.round(((c.spent - p) / p) * 100) : (c.spent > 0 ? null : 0);
    return { name: c.name ?? "без категорії", amount_uah: money(c.spent), prev_uah: money(p), delta_pct: delta };
  });

  const net = cur.income - cur.spend;
  const savingsRate = cur.income > 0 ? Math.round((net / cur.income) * 100) : null;

  // §B/§R3 чесна подушка через канонічний fundsBreakdown: ліквідна = позитивні власні
  // ЛІКВІДНИХ рахунків; борг окремо; інвест-резерв (крипта/брокер) — НЕ подушка.
  const cushion = funds.cushion, debt = funds.debt, investment = funds.investment;

  // §B прогноз не «burn×30»: беремо середнє за 3 ЗАВЕРШЕНІ місяці з тренду (стабільніше й
  // враховує сезонність), fallback — витрати періоду, масштабовані до 30 днів.
  const curMonthKey = `${dTo.getUTCFullYear()}-${String(dTo.getUTCMonth() + 1).padStart(2, "0")}`;
  const completeMonths = trend.filter((t) => t.month !== curMonthKey);
  const last3 = completeMonths.slice(-3);
  const periodScaledBurn = money(Math.round((cur.spend / periodDays) * 30));
  const burnMonthly = last3.length ? Math.round(last3.reduce((s, t) => s + t.spend_uah, 0) / last3.length) : periodScaledBurn;
  const cushionMajor = money(cushion);
  const runwayMonths = burnMonthly > 0 ? Math.round((cushionMajor / burnMonthly) * 10) / 10 : null;

  const anomaliesHint: string[] = [];
  for (const a of actuals) {
    if (a.price_change_pct != null && a.price_change_pct >= 5) {
      anomaliesHint.push(`підписка id=${a.id} подорожчала на ${a.price_change_pct}% (остання ${a.last_amount != null ? money(a.last_amount) : "?"}₴)`);
    }
  }

  const context = {
    period: { type, scope, from, to, days: periodDays, note: scope === "current" ? "поточний період ДО СЬОГОДНІ (ще не завершений — не екстраполюй як повний)" : "завершений період" },
    // §B реальна ситуація користувача — поважай її, не радь «по книжці» (напр. нема роботи → фокус на runway, а не «наростити дохід»).
    user_profile: profile || "(не вказано)",
    current: {
      spend_uah: money(cur.spend), income_uah: money(cur.income), net_uah: money(net),
      savings_rate_pct: savingsRate,
    },
    previous: { spend_uah: money(prev.spend), income_uah: money(prev.income) },
    categories,
    // §B разові (податки/стоматолог/велика покупка) vs регулярний ритм — не проєктуй разові в майбутнє.
    recurring_vs_oneoff: {
      recurring_uah: money(split.recurring.spent),
      oneoff_uah: money(split.oneoff.spent),
      top_oneoff: split.oneoff_items.slice(0, 6).map((o) => ({ merchant: o.merchant, category: o.category, amount_uah: money(o.amount) })),
    },
    top_merchants: (merchants.results ?? []).map((m) => ({ merchant: m.merchant, amount_uah: money(m.spent), n: m.n })),
    notable: (notable.results ?? []).map((n) => ({ tx_id: n.id, merchant: n.merchant, note: n.note, category: n.category, amount_uah: money(n.amount) })),
    biggest_expenses: (big.results ?? []).map((b) => ({ tx_id: b.id, merchant: b.merchant, category: b.category, amount_uah: money(b.amount) })),
    anomalies_hint: anomaliesHint,
    // §B прогноз спирається на ЧЕСНУ подушку (позитивні власні), борг окремо; burn — середнє за 3 завершені міс (не burn×30).
    // §R3 investment_reserve_uah — крипта/брокер: НЕ подушка й НЕ входить у runway, окрема остання лінія.
    forecast: {
      cushion_uah: cushionMajor, debt_uah: money(debt), investment_reserve_uah: money(investment),
      monthly_burn_uah: burnMonthly, burn_method: last3.length ? "середнє за 3 завершені місяці" : "витрати періоду ×30",
      runway_months: runwayMonths,
    },
    // §R3: рахунки з роллю та описом (note) — контекст для AI (не пропонуй продавати інвестиції без потреби).
    accounts: funds.accounts.filter((a) => a.own_uah !== 0 || a.note)
      .map((a) => ({ title: a.title, type: a.type, role: a.role, balance_uah: a.own_uah, note: a.note })),
    // §6: обов'язкові (essential) не варто радити різати; optional — найбезпечніше.
    by_importance: importanceBreakdown,
  };
  return { period: { type, scope, from, to }, context, trend, importance: importanceBreakdown };
}

// Згенерувати й зберегти репорт. force=false → пропускає, якщо для періоду вже є (крон).
export async function generateAndStoreReport(
  env: Env,
  type: ReportType,
  opts: { force?: boolean; scope?: ReportScope } = {},
): Promise<{ id: number; created: boolean }> {
  const { period, context, trend, importance } = await buildReportContext(env, type, opts.scope ?? "last");
  const existing = await env.DB.prepare(
    "SELECT id FROM ai_reports WHERE period_type = ? AND period_from = ? AND period_to = ?",
  ).bind(type, period.from, period.to).first<{ id: number }>();
  if (existing && !opts.force) return { id: existing.id, created: false };

  // Контекст із кількох попередніх репортів того ж типу — щоб AI бачив траєкторію.
  const prior = await env.DB.prepare(
    "SELECT summary FROM ai_reports WHERE period_type = ? ORDER BY period_to DESC LIMIT 3",
  ).bind(type).all<{ summary: string | null }>();
  const priorSummaries = (prior.results ?? []).map((r) => r.summary).filter(Boolean);

  const model = await getTaskModel(env, "report");
  const { result, usage } = await generateFinancialReport(env, { ...(context as object), prior_reports: priorSummaries });
  logUsage("report", usage);
  const cost = callCostUsd(model, usage);
  const now = Math.floor(Date.now() / 1000);
  const summary = result.summary || result.headline || "";
  // Зберігаємо AI-результат + детерміновані дані (тренд, вагомість) для графіків на сторінці.
  const stored = JSON.stringify({ ...result, trend, importance });

  if (existing) {
    await env.DB.prepare(
      "UPDATE ai_reports SET created_at = ?, model = ?, cost_usd = ?, summary = ?, data_json = ? WHERE id = ?",
    ).bind(now, model, cost, summary, stored, existing.id).run();
    return { id: existing.id, created: false };
  }
  const ins = await env.DB.prepare(
    `INSERT INTO ai_reports (period_type, period_from, period_to, created_at, model, cost_usd, summary, data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(type, period.from, period.to, now, model, cost, summary, stored).run();
  return { id: Number(ins.meta.last_row_id), created: true };
}
