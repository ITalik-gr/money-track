// §Аналітика 2.0 — генератор періодичних AI-репортів (Sonnet 5). Збирає КАНОНІЧНИЙ
// контекст (ті самі визначення, що й Статистика/UI), порівнює з тим самим попереднім
// періодом, тягне аномалії (подорожчання підписок, викиди) і описи операцій (user_note),
// кличе Sonnet 5, зберігає структурований репорт у ai_reports. Ідемпотентно по періоду.
import type { Env } from "../../env.ts";
import { getRates } from "../finance/finance.ts";
import { st } from "../platform/i18n.ts";
import { ownerLocale } from "../finance/categories-i18n.ts";
import { fundsBreakdown } from "./advisor.ts";
import {
  STATS_JOINS, EFF_CAT_ID, EFF_CAT_NAME, EFF_IMPORTANCE, EFF_AMOUNT, SPEND_WHERE, INCOME_COUNT, SPEND_TX_COUNT, valueMode, spendSum, incomeSum, amountSum,
  lastCompletePeriod, currentPeriodToDate, recurringOneoffSplit, categoryMonthlyLevels, localMonthStart, localYmSql, localYm,
} from "../finance/stats.ts";
import { plannedActuals } from "../finance/subscriptions.ts";
import { getState } from "../finance/repo.ts";
import { generateFinancialReport, logUsage, getTaskModel, callCostUsd, type FinancialReport } from "./ai.ts";

// `custom` — довільний діапазон, заданий користувачем (кнопка «за свої дати»). Він НЕ має
// пресетних меж, тож `scope` для нього не має сенсу — межі приходять явно в `range`.
export type ReportType = "week" | "month" | "custom";
// last = завершений період (крон); current = поточний до сьогодні (ручна генерація/тест).
export type ReportScope = "last" | "current";
/** Явні межі періоду (unix, включно з `from`, виключно з `to` — як у `lastCompletePeriod`). */
export interface ReportRange { from: number; to: number }

/** Мінімальна/максимальна довжина кастомного періоду. Нижня межа — доба (менше нічого не покаже),
 *  верхня — рік (далі контекст перестає влазити в модель, а «репорт» стає архівом). */
export const CUSTOM_MIN_DAYS = 1;
export const CUSTOM_MAX_DAYS = 366;

/**
 * Межі періоду для генерації.
 *
 * Для `custom` попередній період — той самий проміжок ЗРАЗУ перед `from`. Це єдиний варіант,
 * який тримає «vs минулий період» чесним: порівнювати довільні 17 днів із календарним місяцем
 * означало б, що delta_pct у звіті — це різниця довжин, а не різниця витрат.
 */
function resolveBounds(
  type: ReportType, scope: ReportScope, range?: ReportRange,
): { from: number; to: number; prevFrom: number; prevTo: number } {
  if (type === "custom") {
    if (!range) throw new Error("custom report requires an explicit range");
    const len = range.to - range.from;
    return { from: range.from, to: range.to, prevFrom: range.from - len, prevTo: range.from };
  }
  return scope === "current" ? currentPeriodToDate(type) : lastCompletePeriod(type);
}

// `n` — скільки СПИСАНЬ дало цю суму (канонічний `SPEND_TX_COUNT`). Потрібне не для показу,
// а щоб знати ритм категорії: дельта «−92%» по категорії з одним платежем на місяць — це
// таймінг, а не поведінка (§CADENCE).
interface CatRow { id: number | null; name: string | null; spent: number; n: number }

// Розбивка по ефективній категорії (канонічно, зведено в ₴).
async function cats(env: Env, from: number, to: number, mult: string): Promise<CatRow[]> {
  const r = await env.DB.prepare(
    `SELECT ${EFF_CAT_ID} AS id, ${EFF_CAT_NAME} AS name, ${amountSum(mult)} AS spent, ${SPEND_TX_COUNT} AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
     GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC LIMIT 14`,
  ).bind(from, to).all<CatRow>();
  return r.results ?? [];
}

// `income_n` — та сама ідея для доходу: одна зарплата/інвойс на місяць у тижневому вікні
// дає «дохід впав до нуля», хоча він просто прийшов іншого тижня.
async function totals(env: Env, from: number, to: number, mult: string): Promise<{ spend: number; income: number; income_n: number }> {
  const r = await env.DB.prepare(
    `SELECT ${spendSum(mult)} AS spend, ${incomeSum(mult)} AS income, ${INCOME_COUNT} AS income_n
     FROM transactions t ${STATS_JOINS} WHERE t.time >= ? AND t.time <= ?`,
  ).bind(from, to).first<{ spend: number; income: number; income_n: number }>();
  return { spend: r?.spend ?? 0, income: r?.income ?? 0, income_n: r?.income_n ?? 0 };
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
// §R6: детермінована розбивка по категоріях (надійні суми/дельти проти минулого періоду) —
// зберігаємо в data_json і рендеримо саме її (AI-нотатку приклеюємо за назвою). prev_uah=0 → «новий».
export interface CategoryDetail { name: string; amount_uah: number; prev_uah: number; delta_pct: number | null; note?: string | null }

export async function buildReportContext(
  env: Env, type: ReportType, scope: ReportScope = "last", range?: ReportRange,
): Promise<{
  period: { type: ReportType; scope: ReportScope; from: number; to: number };
  context: unknown;
  trend: TrendPoint[];
  importance: ImportancePoint[];
  categories: CategoryDetail[];
}> {
  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null);
  const { from, to, prevFrom, prevTo } = resolveBounds(type, scope, range);
  const periodDays = Math.max(1, Math.round((to - from) / 86400));

  const [cur, prev, curCats, prevCats, merchants, notable, big, funds, actuals, imp, split, profile, levels] = await Promise.all([
    totals(env, from, to, mult),
    totals(env, prevFrom, prevTo, mult),
    cats(env, from, to, mult),
    cats(env, prevFrom, prevTo, mult),
    env.DB.prepare(
      `SELECT t.merchant AS merchant, ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE} AND t.merchant IS NOT NULL
       GROUP BY t.merchant ORDER BY spent DESC LIMIT 10`,
    ).bind(from, to).all<{ merchant: string; spent: number; n: number }>(),
    // Помітні операції з описом користувача — щоб AI не плутав разове з регулярним.
    env.DB.prepare(
      `SELECT t.id AS id, t.merchant AS merchant, t.user_note AS note, ${EFF_CAT_NAME} AS category,
              CAST(ROUND((-${EFF_AMOUNT}) * ${mult}) AS INTEGER) AS amount
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE} AND t.user_note IS NOT NULL AND t.user_note <> ''
       ORDER BY amount DESC LIMIT 15`,
    ).bind(from, to).all<{ id: string; merchant: string | null; note: string; category: string | null; amount: number }>(),
    // Найбільші разові витрати (кандидати в аномалії).
    env.DB.prepare(
      `SELECT t.id AS id, t.merchant AS merchant, ${EFF_CAT_NAME} AS category,
              CAST(ROUND((-${EFF_AMOUNT}) * ${mult}) AS INTEGER) AS amount
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
       ORDER BY amount DESC LIMIT 6`,
    ).bind(from, to).all<{ id: string; merchant: string | null; category: string | null; amount: number }>(),
    fundsBreakdown(env),
    plannedActuals(env.DB),
    importance(env, from, to, mult),
    recurringOneoffSplit(env, from, to, mult),
    getState(env.DB, "finance_profile"),
    // Канонічний місячний рівень категорії — щоб у тижневому звіті було з ЧИМ порівняти
    // місячний платіж, окрім сусіднього тижня (де його просто не було).
    categoryMonthlyLevels(env, mult, { now: to }),
  ]);

  const money = (minor: number) => Math.round(minor / 100);

  // §6: розбивка вагомості (сортована essential→discretionary→optional) для рендеру + AI.
  const IMP_ORDER = ["essential", "discretionary", "optional"];
  const impTotal = Object.values(imp).reduce((s, v) => s + v, 0);
  const importanceBreakdown: ImportancePoint[] = IMP_ORDER
    .filter((lv) => (imp[lv] ?? 0) > 0)
    .map((lv) => ({ level: lv, amount_uah: money(imp[lv]), pct: impTotal > 0 ? Math.round((imp[lv] / impTotal) * 100) : 0 }));

  // §5: тренд 6 місяців (spend/income по місяцях) — для лінії на сторінці репорту.
  const trendFrom = localMonthStart(to, -5);
  const trendRows = await env.DB.prepare(
    `SELECT ${localYmSql(to)} AS m, ${spendSum(mult)} AS spend, ${incomeSum(mult)} AS income
     FROM transactions t ${STATS_JOINS} WHERE t.time >= ? AND t.time <= ? GROUP BY m ORDER BY m`,
  ).bind(trendFrom, to).all<{ m: string; spend: number; income: number }>();
  const trend: TrendPoint[] = (trendRows.results ?? []).map((r) => ({ month: r.m, spend_uah: money(r.spend), income_uah: money(r.income) }));

  const prevMap = new Map(prevCats.map((c) => [c.id, c.spent]));
  const prevNMap = new Map(prevCats.map((c) => [c.id, c.n]));
  const loc = await ownerLocale(env.DB);
  const categories = curCats.map((c) => {
    const p = prevMap.get(c.id) ?? 0;
    const delta = p > 0 ? Math.round(((c.spent - p) / p) * 100) : (c.spent > 0 ? null : 0);
    return { name: c.name ?? st(loc, "uncategorized"), amount_uah: money(c.spent), prev_uah: money(p), delta_pct: delta };
  });

  // §CADENCE — ритм списань. Період, коротший за місяць, не може чесно порівнювати категорію,
  // яку списують раз на місяць: підписка 99 ₴ цього тижня проти 1300 ₴ минулого читалась моделлю
  // як «підписки впали на 92%», хоча це той самий календар, а не зміна поведінки. Дельта осмислена
  // лише коли з ОБОХ боків є ≥2 списання; інакше даємо канонічний місячний рівень як точку опори.
  const shortPeriod = periodDays < 28;
  const categoriesForAi = curCats.map((c, i) => {
    const lvl = c.id != null ? levels.get(c.id) : undefined;
    const prevN = prevNMap.get(c.id) ?? 0;
    return {
      ...categories[i],
      charges_n: c.n,
      prev_charges_n: prevN,
      monthly_usual_uah: lvl ? money(lvl.level) : null,
      // `fixed` з canonical categoryMonthlyLevels: стабільна сума останніх місяців = підписка/оренда.
      billing: lvl?.fixed ? "monthly_fixed" : "variable",
      delta_meaningful: !shortPeriod || (c.n >= 2 && prevN >= 2),
    };
  });

  const net = cur.income - cur.spend;
  const savingsRate = cur.income > 0 ? Math.round((net / cur.income) * 100) : null;

  // §B/§R3 чесна подушка через канонічний fundsBreakdown: ліквідна = позитивні власні
  // ЛІКВІДНИХ рахунків; борг окремо; інвест-резерв (крипта/брокер) — НЕ подушка.
  const cushion = funds.cushion, debt = funds.debt, investment = funds.investment;

  // §B прогноз не «burn×30»: беремо середнє за 3 ЗАВЕРШЕНІ місяці з тренду (стабільніше й
  // враховує сезонність), fallback — витрати періоду, масштабовані до 30 днів.
  // Той самий ключ, у якому згруповано `trend` (локальна зона) — інакше «поточний неповний
  // місяць» не збігся б із жодним рядком і потрапив би в середнє як завершений.
  const curMonthKey = localYm(to);
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
    period: {
      type, scope, from, to, days: periodDays,
      // Модель мусить знати, чи період завершений: інакше вона екстраполює півтижня як тиждень.
      // Для custom довжина довільна, тож і «previous» — рівно такий самий проміжок перед ним.
      note: type === "custom"
        ? `довільний діапазон на ${periodDays} дн., обраний користувачем; previous — такий самий за довжиною проміжок безпосередньо перед ним`
        : scope === "current"
          ? "поточний період ДО СЬОГОДНІ (ще не завершений — не екстраполюй як повний)"
          : "завершений період",
    },
    // §B реальна ситуація користувача — поважай її, не радь «по книжці» (напр. нема роботи → фокус на runway, а не «наростити дохід»).
    user_profile: profile || "(не вказано)",
    current: {
      spend_uah: money(cur.spend), income_uah: money(cur.income), net_uah: money(net),
      savings_rate_pct: savingsRate, income_charges_n: cur.income_n,
    },
    previous: { spend_uah: money(prev.spend), income_uah: money(prev.income), income_charges_n: prev.income_n },
    // §CADENCE: у короткому періоді різниця доходу з ≤1 надходженням з будь-якого боку означає
    // «зарплата/інвойс прийшов іншого тижня», а не «дохід зник».
    income_delta_meaningful: !shortPeriod || (cur.income_n >= 2 && prev.income_n >= 2),
    categories: categoriesForAi,
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
  return { period: { type, scope, from, to }, context, trend, importance: importanceBreakdown, categories };
}

// Згенерувати й зберегти репорт. force=false → пропускає, якщо для періоду вже є (крон).
export async function generateAndStoreReport(
  env: Env,
  type: ReportType,
  opts: { force?: boolean; scope?: ReportScope; range?: ReportRange } = {},
): Promise<{ id: number; created: boolean }> {
  const { period, context, trend, importance, categories } = await buildReportContext(env, type, opts.scope ?? "last", opts.range);
  const existing = await env.DB.prepare(
    "SELECT id FROM ai_reports WHERE period_type = ? AND period_from = ? AND period_to = ?",
  ).bind(type, period.from, period.to).first<{ id: number }>();
  if (existing && !opts.force) return { id: existing.id, created: false };

  // Контекст із кількох попередніх репортів — щоб AI бачив траєкторію. Для `custom` фільтр за
  // типом зняли: перший же кастомний репорт мав би порожню траєкторію, хоча тижневі/місячні
  // підсумки за той самий час уже лежать поруч і саме вони й описують «звідки ми йдемо».
  const prior = type === "custom"
    ? await env.DB.prepare(
        "SELECT summary, data_json FROM ai_reports WHERE period_type <> 'custom' ORDER BY period_to DESC LIMIT 3",
      ).all<{ summary: string | null; data_json: string | null }>()
    : await env.DB.prepare(
        "SELECT summary, data_json FROM ai_reports WHERE period_type = ? ORDER BY period_to DESC LIMIT 3",
      ).bind(type).all<{ summary: string | null; data_json: string | null }>();
  const priorSummaries = (prior.results ?? []).map((r) => r.summary).filter(Boolean);

  // §NOVELTY — що вже прозвучало. Самих `summary` було замало: модель щотижня «відкривала»
  // те саме («квартира забрала багато»), бо найбільша категорія найбільша щомісяця, і звіт
  // читався як копія попереднього. Даємо ЯВНИЙ список тем — заголовки, мітки аномалій і назви
  // порад останніх звітів — і забороняємо подавати їх як новину вдруге.
  const covered = new Set<string>();
  for (const r of prior.results ?? []) {
    try {
      const d = JSON.parse(r.data_json ?? "{}") as Partial<FinancialReport>;
      if (d.headline) covered.add(String(d.headline));
      for (const a of d.anomalies ?? []) if (a?.label) covered.add(String(a.label));
      for (const a of d.advice ?? []) if (a?.title) covered.add(String(a.title));
    } catch {
      // Старий або пошкоджений data_json не має валити генерацію нового звіту.
    }
  }

  const model = await getTaskModel(env, "report");
  const { result, usage } = await generateFinancialReport(env, {
    ...(context as object), prior_reports: priorSummaries, already_covered: [...covered].slice(0, 24),
  });
  logUsage("report", usage);
  const cost = callCostUsd(model, usage);
  const now = Math.floor(Date.now() / 1000);
  const summary = result.summary || result.headline || "";
  // §R6: детерміновані категорії (надійні суми/дельти) + приклеєна AI-нотатка за назвою —
  // рендеримо саме їх, щоб «vs минулий період» не був порожнім через null-и від AI.
  const noteByName = new Map((result.category_breakdown ?? []).map((cb) => [cb.name, cb.note ?? null]));
  const categoriesDetail = categories.map((c) => ({ ...c, note: noteByName.get(c.name) ?? null }));
  // Зберігаємо AI-результат + детерміновані дані (категорії, тренд, вагомість) для графіків на сторінці.
  const stored = JSON.stringify({ ...result, trend, importance, categories: categoriesDetail });

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
