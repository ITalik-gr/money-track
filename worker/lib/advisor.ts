// AI-порадник (структурований): рахуємо runway із власних коштів і місячного burn,
// подаємо разом із профілем ситуації в Haiku → поради-картки. Кешуємо в app_state.
import type { Env } from "../env.ts";
import { type AdviceResult, type AiUsageBrief, type BudgetChatResult, type ChatMsg, type ChatTool, type StructuredInsight, briefUsage, budgetChat, chatAdvice, evaluateGroup, generateAdvice, logUsage, proposeBudgetLimits, txChat } from "./ai.ts";
import { getState, setState } from "./repo.ts";
import { getRates, toUAHMinor } from "./finance.ts";
import { nextChargeUnix } from "./subscriptions.ts";
import { STATS_JOINS, EFF_CAT_ID, EFF_CAT_NAME, EFF_CAT_COLOR, EFF_IMPORTANCE, SPEND_WHERE, INCOME_WHERE, valueMode, spendSum, incomeSum, amountSum, recurringOneoffSplit, categoryMonthlyLevels, sumLevels } from "./stats.ts";

// Короткий підпис транзакції для чипів/цитування AI: мерчант + сума (major) у ₴.
interface TxLabelRow { id: string; merchant: string | null; comment: string | null; amount: number; currency_code: number }
function txLabel(t: TxLabelRow): { id: string; label: string } {
  const name = (t.merchant || t.comment || "операція").slice(0, 24);
  const sign = t.currency_code === 840 ? "$" : t.currency_code === 978 ? "€" : "₴";
  return { id: t.id, label: `${name} ${Math.round(t.amount / 100)}${sign}` };
}

// Помітні транзакції за останні N днів (для контексту чату — AI може цитувати їх як чипи).
async function notableTransactions(env: Env, days = 45, limit = 15): Promise<{ id: string; label: string }[]> {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = await env.DB.prepare(
    `SELECT id, merchant, comment, amount, currency_code FROM transactions
     WHERE time >= ? AND is_transfer = 0 AND amount < 0
     ORDER BY amount ASC LIMIT ?`,
  ).bind(since, limit).all<TxLabelRow>();
  return (rows.results ?? []).map(txLabel);
}

export interface StoredAdvice extends AdviceResult {
  own_funds: number;      // копійки, UAH — нетто (подушка − борг)
  cushion: number;        // копійки, UAH — ліквідна подушка (позитивні власні)
  debt: number;           // копійки, UAH — борг по кредитці (від'ємні власні)
  investment: number;     // копійки, UAH — інвест-резерв (крипта/брокер), не подушка
  monthly_burn: number;   // копійки, UAH/міс
  runway_months: number | null;  // ЧЕСНИЙ: подушка / burn
  usage?: AiUsageBrief;
  generated_at: number;
}

// §C: чесна розбивка коштів. Ліквідна ПОДУШКА = сума ПОЗИТИВНИХ власних залишків (те, що
// реально є: заощадження в ₴/USD, плюсові картки). БОРГ = сума ВІД'ЄМНИХ власних (використаний
// кредитний ліміт). Нетто = подушка − борг. Раніше показували лише нетто, і від'ємний нетто
// (борг по кредитці) виглядав як «мінус запас», хоч реальна подушка сиділа окремо.
// §R3: один рахунок у розкладі коштів — для контексту AI (роль + опис користувача).
export interface AccountFunds { title: string | null; type: string | null; role: "liquid" | "investment"; own_uah: number; note: string | null }
// cushion — ЛІКВІДНА подушка (позитивні власні ліквідних рахунків); debt — борг (кредит);
// investment — інвест-резерв (позитивні власні інвест-рахунків, напр. крипта): НЕ подушка,
// але остання лінія; net = cushion − debt (без інвестицій — консервативний runway).
export interface FundsBreakdown { cushion: number; debt: number; investment: number; net: number; accounts: AccountFunds[] }
export async function fundsBreakdown(env: Env): Promise<FundsBreakdown> {
  const accounts = await env.DB.prepare(
    "SELECT title, type, role, ai_note, balance, credit_limit, currency_code FROM accounts WHERE is_active = 1",
  ).all<{ title: string | null; type: string | null; role: string | null; ai_note: string | null; balance: number; credit_limit: number; currency_code: number }>();
  const rates = await getRates(env.DB);
  let cushion = 0, debt = 0, investment = 0;
  const list: AccountFunds[] = [];
  for (const a of accounts.results ?? []) {
    const own = toUAHMinor((a.balance ?? 0) - (a.credit_limit ?? 0), a.currency_code, rates);
    const role: "liquid" | "investment" = a.role === "investment" ? "investment" : "liquid";
    if (role === "investment") { if (own > 0) investment += own; else debt += -own; }
    else { if (own >= 0) cushion += own; else debt += -own; }
    list.push({ title: a.title, type: a.type, role, own_uah: Math.round(own / 100), note: a.ai_note });
  }
  return {
    cushion: Math.round(cushion), debt: Math.round(debt), investment: Math.round(investment),
    net: Math.round(cushion - debt), accounts: list,
  };
}

async function ownFundsUAH(env: Env): Promise<number> {
  return (await fundsBreakdown(env)).net;
}

export async function getProfile(env: Env): Promise<string> {
  return (await getState(env.DB, "finance_profile")) ?? "";
}
export async function setProfile(env: Env, text: string): Promise<void> {
  await setState(env.DB, "finance_profile", text);
}

// §CTX (2026-07-14): ЄДИНЕ джерело фінансового контексту для AI — і для Порадника
// (`buildAdvice`), і для чату (`chatReply`). Раніше чат мав збіднений контекст (лише нетто
// own_funds + наївний burn 90д÷3), тож його числа розходились із Порадником, а AI домислював
// «подушку $780». Тепер обидва беруть той самий знімок: розбивка коштів (подушка/борг/інвест +
// рахунки з ролями й нотатками), канонічний burn (sumLevels), підписки, бюджети, вагомість,
// тренд 6 міс, разові/регулярні та найближчі списання — консистентні цифри всюди.
export interface FinanceSnapshot {
  now: number;
  funds: FundsBreakdown;
  ownFunds: number;                        // копійки, нетто (подушка − борг)
  monthlyBurn: number;                     // копійки/міс (sumLevels — канон)
  runwayMonths: number | null;             // ЧЕСНИЙ: подушка / burn
  subsMonthly: number;                     // грн/міс (major)
  citable: { id: string; label: string }[]; // операції з id для цитат [tx:ID]
  context: Record<string, unknown>;        // спільний JSON-контекст для AI (без tx-блоків)
}

export async function collectFinanceSnapshot(env: Env): Promise<FinanceSnapshot> {
  const now = Math.floor(Date.now() / 1000);
  const from90 = now - 90 * 86400;
  const dNow = new Date(now * 1000);
  const monthStart = Math.floor(new Date(dNow.getFullYear(), dNow.getMonth(), 1).getTime() / 1000);
  const from6mo = Math.floor(new Date(dNow.getFullYear(), dNow.getMonth() - 5, 1).getTime() / 1000);

  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null); // канонічно, зведено в ₴
  const [funds, levels, cats, merchants, events, importance, trend, budgetRows, monthByCat, subsAgg, split, upcomingRows] = await Promise.all([
    fundsBreakdown(env),
    // P1: канонічний місячний рівень категорій — джерело і для avg_month, і для burn (sumLevels).
    categoryMonthlyLevels(env, mult, { now }),
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, ${EFF_CAT_NAME} AS name, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND ${SPEND_WHERE}
       GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC LIMIT 8`,
    ).bind(from90).all<{ id: number; name: string; spent: number }>(),
    env.DB.prepare(
      `SELECT t.merchant AS merchant, ${amountSum(mult)} AS spent FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND ${SPEND_WHERE} AND t.merchant IS NOT NULL
       GROUP BY t.merchant ORDER BY spent DESC LIMIT 8`,
    ).bind(from90).all<{ merchant: string; spent: number }>(),
    env.DB.prepare(
      `SELECT e.name AS name, ${amountSum(mult)} AS spent FROM transactions t JOIN event_groups e ON e.id = t.event_id
       WHERE t.time >= ? AND t.amount < 0 AND t.is_transfer = 0
       GROUP BY t.event_id ORDER BY spent DESC LIMIT 6`,
    ).bind(from90).all<{ name: string; spent: number }>(),
    // §6: розподіл витрат за вагомістю — щоб AI радив, що безпечно різати (необов'язкове).
    env.DB.prepare(
      `SELECT ${EFF_IMPORTANCE} AS importance, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND ${SPEND_WHERE}
       GROUP BY ${EFF_IMPORTANCE}`,
    ).bind(from90).all<{ importance: string; spent: number }>(),
    // §2: тренд 6 місяців (spend+income по місяцях) — щоб AI бачив траєкторію, не лише 90д.
    env.DB.prepare(
      `SELECT strftime('%Y-%m', t.time, 'unixepoch') AS m, ${spendSum(mult)} AS spend, ${incomeSum(mult)} AS income
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? GROUP BY m ORDER BY m`,
    ).bind(from6mo).all<{ m: string; spend: number; income: number }>(),
    // §2: бюджети (ліміт на місяць) + факт за цей місяць → over/under.
    env.DB.prepare(
      `SELECT b.category_id AS id, c.name AS name, b.amount AS lim
       FROM budgets b JOIN categories c ON c.id = b.category_id WHERE b.period = 'month'`,
    ).all<{ id: number; name: string; lim: number }>(),
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND ${SPEND_WHERE} GROUP BY ${EFF_CAT_ID}`,
    ).bind(monthStart).all<{ id: number; spent: number }>(),
    // §2: фіксовані зобовʼязання — сума активних підписок на місяць.
    env.DB.prepare(
      `SELECT COALESCE(SUM(period_amount), 0) AS planned, COUNT(*) AS n FROM planned_payments WHERE is_active = 1`,
    ).first<{ planned: number; n: number }>(),
    // §E1/C: разові vs регулярні за поточний місяць — щоб AI не проектував разове як норму.
    recurringOneoffSplit(env, monthStart, now, mult),
    // §CTX: найближчі планові списання (для «коли платити») — рахуємо nextChargeUnix у JS.
    env.DB.prepare(
      `SELECT title, period, period_count, start_date, period_amount, kind FROM planned_payments WHERE is_active = 1`,
    ).all<{ title: string; period: string; period_count: number; start_date: number; period_amount: number | null; kind: string }>(),
  ]);

  const ownFunds = funds.net;
  // P1 (2026-07-14): burn = сума місячних рівнів категорій (канон), а не «витрати_90д ÷ 3».
  // Узгоджено з Патернами/Бюджетами; не роздувається разовими лумпами (податок/лікар).
  const monthlyBurn = sumLevels(levels);
  // §C: ЧЕСНИЙ runway — від ліквідної подушки, не від нетто (нетто може бути від'ємним через борг).
  const runwayMonths = monthlyBurn > 0 ? Math.round((funds.cushion / monthlyBurn) * 10) / 10 : null;
  const profile = await getProfile(env);

  // §2: бюджети — ліміт vs факт за поточний місяць.
  const monthSpent = new Map((monthByCat.results ?? []).map((r) => [r.id, Math.abs(r.spent)]));
  const budgets = (budgetRows.results ?? []).map((b) => {
    const spent = monthSpent.get(b.id) ?? 0;
    return { category: b.name, limit_uah: Math.round(b.lim / 100), spent_uah: Math.round(spent / 100), used_pct: b.lim > 0 ? Math.round((spent / b.lim) * 100) : null };
  });
  const subsMonthly = Math.round((subsAgg?.planned ?? 0) / 100);
  // `levels` (канонічний місячний рівень) уже завантажено вище в Promise.all — джерело avg_month і burn.
  const catAvgMonth = (id: number, spent90: number) => Math.round((levels.get(id)?.level ?? spent90 / 3) / 100);
  // §2/§5: найбільші операції з id — щоб AI цитував конкретику токеном [tx:ID].
  const citable = await notableTransactions(env, 90, 12);

  // §CTX: списання в найближчі 30 днів — щоб AI радив пріоритет/тайминг платежів.
  const in30 = now + 30 * 86400;
  const upcoming = (upcomingRows.results ?? [])
    .map((p) => ({ title: p.title, at: nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, now), amount_uah: Math.round((p.period_amount ?? 0) / 100), kind: p.kind }))
    .filter((p) => p.at <= in30)
    .sort((a, b) => a.at - b.at)
    .slice(0, 12)
    .map((p) => ({ title: p.title, in_days: Math.max(0, Math.round((p.at - now) / 86400)), amount_uah: p.amount_uah, kind: p.kind }));

  const context: Record<string, unknown> = {
    period_note: "top_categories/top_merchants/by_event — суми за ОСТАННІ 90 ДНІВ (3 місяці); avg_month_uah — усереднене на місяць. monthly_burn_uah — середні витрати/міс. НЕ плутай 90д із місячною; спирайся на avg_month_uah. by_importance: essential=обов'язкові (не ріж), discretionary=бажані, optional=необов'язкові (найбезпечніше скорочувати). monthly_trend: spend/income по місяцях (6 міс) — дивись динаміку/сезонність, а не лише середнє. budgets: ліміт vs факт цього місяця (used_pct>100 = перевитрата — підсвіти). subscriptions_monthly_uah: фіксовані підписки/міс (майже незмінні). upcoming_charges: найближчі списання (in_days) — використовуй для порад про тайминг/пріоритет платежів. recent_oneoff — РАЗОВІ витрати цього місяця (податки, лікар, велика покупка): НЕ проектуй їх як регулярні. Цитуй конкретику: категорії, підписки, бюджети.",
    period_days: 90,
    situation: profile || "(не вказано)",
    // §C: реальна картина коштів. liquid_cushion — те, що справді є (заощадження/плюсові рахунки);
    // debt — використаний кредитний ліміт (це БОРГ, не «мінус запас»); own_funds = подушка − борг.
    liquid_cushion_uah: Math.round(funds.cushion / 100),
    debt_uah: Math.round(funds.debt / 100),
    own_funds_uah: Math.round(ownFunds / 100),
    // §R3: інвест-резерв (крипта/брокер) — НЕ ліквідна подушка й НЕ входить у runway за
    // замовчуванням; але це остання лінія, якщо все закінчиться. Не радь одразу «продати».
    investment_reserve_uah: Math.round(funds.investment / 100),
    accounts: funds.accounts
      .filter((a) => a.own_uah !== 0 || a.note)
      .map((a) => ({ title: a.title, type: a.type, role: a.role, balance_uah: a.own_uah, note: a.note })),
    accounts_note: "accounts — рахунки користувача з роллю та ОПИСОМ (note). role='investment' (крипта/брокер) — НЕ подушка за замовчуванням (не входить у liquid_cushion/runway), але остання лінія на крайній випадок. Враховуй note кожного рахунку. Не пропонуй продавати інвестиції, поки ситуація не критична.",
    runway_note: "runway_months = ліквідна подушка / місячний burn (скільки протягнеш на реальні кошти БЕЗ інвестицій). Спирайся на подушку, а не на нетто.",
    monthly_burn_uah: Math.round(monthlyBurn / 100),
    runway_months: runwayMonths,
    recent_oneoff: {
      total_uah: Math.round(split.oneoff.spent / 100),
      items: split.oneoff_items.map((o) => ({ merchant: o.merchant, category: o.category, amount_uah: Math.round(o.amount / 100) })),
    },
    subscriptions_monthly_uah: subsMonthly,
    subscriptions_count: subsAgg?.n ?? 0,
    upcoming_charges: upcoming,
    top_categories: (cats.results ?? []).map((c) => ({ id: c.id, name: c.name, spent_90d_uah: Math.round(c.spent / 100), avg_month_uah: catAvgMonth(c.id, c.spent) })),
    top_merchants: (merchants.results ?? []).map((m) => ({ merchant: m.merchant, spent_90d_uah: Math.round(m.spent / 100), avg_month_uah: Math.round(m.spent / 3 / 100) })),
    by_event: (events.results ?? []).map((e) => ({ event: e.name, spent_90d_uah: Math.round(e.spent / 100), avg_month_uah: Math.round(e.spent / 3 / 100) })),
    by_importance: (importance.results ?? []).map((x) => ({ level: x.importance, spent_90d_uah: Math.round(x.spent / 100) })),
    monthly_trend: (trend.results ?? []).map((t) => ({ month: t.m, spend_uah: Math.round(t.spend / 100), income_uah: Math.round(t.income / 100) })),
    budgets,
  };

  return { now, funds, ownFunds, monthlyBurn, runwayMonths, subsMonthly, citable, context };
}

export async function buildAdvice(env: Env): Promise<StoredAdvice> {
  const snap = await collectFinanceSnapshot(env);
  const { funds, ownFunds, monthlyBurn, runwayMonths, citable, context } = snap;
  const now = snap.now;
  const payload = { ...context, citable_operations: citable }; // [{id, label}] — для цитат [tx:ID]

  const { result, usage } = await generateAdvice(env, payload);
  logUsage("advice", usage);
  const stored: StoredAdvice = {
    ...result,
    own_funds: ownFunds,
    cushion: funds.cushion,
    debt: funds.debt,
    investment: funds.investment,
    monthly_burn: monthlyBurn,
    runway_months: runwayMonths,
    usage: briefUsage(usage),
    generated_at: now,
  };
  await setState(env.DB, "advisor", JSON.stringify(stored));

  // §2: історія порад — компактні знімки (останні 12), щоб бачити траєкторію рекомендацій.
  try {
    const rawHist = await getState(env.DB, "advisor_history");
    const hist: AdviceHistoryItem[] = rawHist ? JSON.parse(rawHist) : [];
    hist.unshift({
      generated_at: now,
      summary: result.summary || result.runway_comment || "",
      runway_months: runwayMonths,
      monthly_burn: monthlyBurn,
      own_funds: ownFunds,
      cushion: funds.cushion, // §+1: ліквідна подушка окремо (для тренду/дельт)
    });
    await setState(env.DB, "advisor_history", JSON.stringify(hist.slice(0, 24)));
  } catch { /* історія не критична */ }

  return stored;
}

export interface AdviceHistoryItem {
  generated_at: number; summary: string; runway_months: number | null; monthly_burn: number; own_funds: number;
  cushion?: number; // §+1: додано пізніше — старі записи можуть не мати
}
export async function getAdviceHistory(env: Env): Promise<AdviceHistoryItem[]> {
  const raw = await getState(env.DB, "advisor_history");
  return raw ? (JSON.parse(raw) as AdviceHistoryItem[]) : [];
}
export async function clearAdviceHistory(env: Env): Promise<void> {
  await setState(env.DB, "advisor_history", JSON.stringify([]));
}

export async function getStoredAdvice(env: Env): Promise<StoredAdvice | null> {
  const raw = await getState(env.DB, "advisor");
  return raw ? (JSON.parse(raw) as StoredAdvice) : null;
}

// AI-планувальник бюджету: середні витрати по категоріях + ситуація → пропозиції
// місячних лімітів-конвертів (приймаються одним тапом на сторінці «Бюджети»).
export interface BudgetProposalRow {
  category_id: number;
  name: string;
  color: string | null;
  avg_month: number;      // копійки, середнє за 3 міс
  current_limit: number;  // копійки, поточний ліміт (0 якщо нема)
  suggested: number;      // копійки, пропозиція AI
  reason: string;
}
export interface BudgetPlanResult {
  rows: BudgetProposalRow[];
  overall: string;
  runway_months: number | null;
  generated_at: number;
}

export async function proposeBudgets(env: Env): Promise<BudgetPlanResult> {
  const now = Math.floor(Date.now() / 1000);
  const from90 = now - 90 * 86400;

  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null);
  const [ownFunds, spendRows, budgetRows] = await Promise.all([
    ownFundsUAH(env),
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS category_id, ${EFF_CAT_NAME} AS name, ${EFF_CAT_COLOR} AS color, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND ${SPEND_WHERE}
       GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC`,
    ).bind(from90).all<{ category_id: number; name: string; color: string | null; spent: number }>(),
    env.DB.prepare("SELECT category_id, amount FROM budgets WHERE period = 'month'").all<{ category_id: number; amount: number }>(),
  ]);

  const cats = spendRows.results ?? [];
  const currentLimit = new Map<number, number>();
  for (const b of budgetRows.results ?? []) if (b.category_id != null) currentLimit.set(b.category_id, b.amount);

  // Канонічний місячний рівень (fixed=останній платіж, змінні=середнє) — узгоджено з рештою.
  const levels = await categoryMonthlyLevels(env, mult, { now });
  const catLevel = (id: number, spent90: number) => levels.get(id)?.level ?? Math.round(spent90 / 3);

  // P1: burn = сума канонічних місячних рівнів (узгоджено з порадником/патернами).
  const monthlyBurn = sumLevels(levels);
  const runwayMonths = monthlyBurn > 0 ? Math.round((ownFunds / monthlyBurn) * 10) / 10 : null;

  const payload = {
    situation: (await getProfile(env)) || "(не вказано)",
    own_funds_uah: Math.round(ownFunds / 100),
    monthly_burn_uah: Math.round(monthlyBurn / 100),
    runway_months: runwayMonths,
    categories: cats.map((c) => ({
      id: c.category_id,
      name: c.name,
      avg_month_uah: Math.round(catLevel(c.category_id, c.spent) / 100),
      current_limit_uah: Math.round((currentLimit.get(c.category_id) ?? 0) / 100),
    })),
  };

  const { result, usage } = await proposeBudgetLimits(env, payload);
  logUsage("budget-plan", usage);
  const byId = new Map(result.proposals.map((p) => [p.category_id, p]));

  const rows: BudgetProposalRow[] = cats.map((c) => {
    const p = byId.get(c.category_id);
    const avgMonth = catLevel(c.category_id, c.spent);
    return {
      category_id: c.category_id,
      name: c.name,
      color: c.color,
      avg_month: avgMonth,
      current_limit: currentLimit.get(c.category_id) ?? 0,
      suggested: p ? Math.round(p.limit_uah * 100) : avgMonth,
      reason: p?.reason ?? "",
    };
  });

  return { rows, overall: result.overall, runway_months: runwayMonths, generated_at: now };
}

// §3: діалоговий бюджет — будуємо контекст (категорії з avg/ліміт/вагомість) і ведемо чат.
export async function budgetChatReply(env: Env, messages: ChatMsg[]): Promise<BudgetChatResult & { usage: AiUsageBrief }> {
  const now = Math.floor(Date.now() / 1000);
  const from90 = now - 90 * 86400;
  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null);
  const [ownFunds, spendRows, budgetRows] = await Promise.all([
    ownFundsUAH(env),
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, ${EFF_CAT_NAME} AS name, ${amountSum(mult)} AS spent, ${EFF_IMPORTANCE} AS importance
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND ${SPEND_WHERE}
       GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC LIMIT 14`,
    ).bind(from90).all<{ id: number; name: string; spent: number; importance: string }>(),
    env.DB.prepare("SELECT category_id, amount FROM budgets WHERE period = 'month'").all<{ category_id: number; amount: number }>(),
  ]);
  const limit = new Map<number, number>();
  for (const b of budgetRows.results ?? []) if (b.category_id != null) limit.set(b.category_id, b.amount);
  const cats = spendRows.results ?? [];
  const levels = await categoryMonthlyLevels(env, mult, { now });
  const catLevel = (id: number, spent90: number) => levels.get(id)?.level ?? Math.round(spent90 / 3);
  // P1: burn = сума канонічних місячних рівнів (узгоджено з порадником/патернами).
  const monthlyBurn = sumLevels(levels);

  const ctx = {
    situation: (await getProfile(env)) || "(не вказано)",
    own_funds_uah: Math.round(ownFunds / 100),
    monthly_burn_uah: Math.round(monthlyBurn / 100),
    categories: cats.map((c) => ({
      id: c.id, name: c.name, importance: c.importance,
      avg_month_uah: Math.round(catLevel(c.id, c.spent) / 100),
      current_limit_uah: Math.round((limit.get(c.id) ?? 0) / 100),
    })),
  };

  const { result, usage } = await budgetChat(env, ctx, messages);
  logUsage("budget-chat", usage);
  return { ...result, usage: briefUsage(usage) };
}

// Чат-порадник: діалог по фінансах із контекстом (профіль + власні + burn + топ-категорії
// + помітні транзакції з id, які AI може цитувати чипами; + прикріплені юзером операції).
export async function chatReply(env: Env, messages: ChatMsg[], attachedTxIds: string[] = []): Promise<{ reply: string }> {
  // §CTX (2026-07-14): чат тепер отримує ТОЙ САМИЙ багатий знімок, що й Порадник
  // (`collectFinanceSnapshot`) — розбивка коштів, канонічний burn/runway, підписки, бюджети,
  // вагомість, тренд, разові, найближчі списання. Раніше контекст був збіднений (нетто + 90д÷3),
  // тож AI «домислював подушку» й давав числа, що не збігались із екраном Порадника.
  const snap = await collectFinanceSnapshot(env);

  // Прикріплені юзером транзакції — беруть пріоритет у контексті.
  let attached: { id: string; label: string }[] = [];
  if (attachedTxIds.length) {
    const ph = attachedTxIds.slice(0, 10).map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id, merchant, comment, amount, currency_code FROM transactions WHERE id IN (${ph})`,
    ).bind(...attachedTxIds.slice(0, 10)).all<TxLabelRow>();
    attached = (rows.results ?? []).map(txLabel);
  }

  // Транзакції для контексту: прикріплені (пріоритет) + помітні зі знімка (дедуп за id).
  const seen = new Set(attached.map((t) => t.id));
  const transactions = [...attached, ...snap.citable.filter((t) => !seen.has(t.id))].slice(0, 20);
  const context = {
    ...snap.context,
    attached_transactions: attached,
    transactions,
  };

  const { text, usage } = await chatAdvice(env, context, messages, {
    tools: financeChatTools(),
    executor: (name, input) => runFinanceTool(env, name, input),
  });
  logUsage("chat", usage);
  return { reply: text };
}

// §AGENT (2026-07-14): інструменти чату — доступ до ПОВНОЇ бази операцій поза фіксованим
// контекстом. Усі суми зводяться в ₴ канонічно (valueMode/mult); фільтри — канонічні
// SPEND_WHERE/INCOME_WHERE. Дозволяє питання «скільки на таксі влітку торік» без роздування
// контексту. Домаінна логіка тут; транспорт tool-use — в ai.ts (runToolConversation).
export function financeChatTools(): ChatTool[] {
  const dateProp = { type: "string", description: "Дата у форматі YYYY-MM-DD" };
  return [
    {
      name: "query_spend",
      description: "Порахувати суму витрат або доходу користувача за період (у ГРН, зведено за курсом), з опційним фільтром по категорії/мерчанту та групуванням. Для питань «скільки я витратив/заробив на X за період Y».",
      input_schema: {
        type: "object",
        properties: {
          from_date: { ...dateProp, description: "Початок періоду (включно), YYYY-MM-DD" },
          to_date: { ...dateProp, description: "Кінець періоду (включно), YYYY-MM-DD" },
          flow: { type: "string", enum: ["spend", "income"], description: "Витрати чи доходи. Дефолт spend." },
          category: { type: "string", description: "Назва категорії, частковий збіг (напр. «Таксі»). Опційно." },
          merchant: { type: "string", description: "Назва мерчанта, частковий збіг (напр. «Uklon»). Опційно." },
          group_by: { type: "string", enum: ["none", "month", "category", "merchant"], description: "Групування. Дефолт none." },
        },
        required: ["from_date", "to_date"],
      },
    },
    {
      name: "find_transactions",
      description: "Знайти конкретні операції за фільтрами (повертає id, дату, мерчанта, суму в ₴, категорію). Використовуй, коли треба показати приклади операцій, а не лише суму. id можна цитувати як [tx:ID|підпис].",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Текст у назві мерчанта/коментарі. Опційно." },
          from_date: { ...dateProp, description: "Від дати (включно). Опційно." },
          to_date: { ...dateProp, description: "До дати (включно). Опційно." },
          category: { type: "string", description: "Назва категорії, частковий збіг. Опційно." },
          flow: { type: "string", enum: ["spend", "income", "any"], description: "Дефолт any." },
          min_amount_uah: { type: "number", description: "Мінімальна |сума| у ₴. Опційно." },
          limit: { type: "number", description: "Скільки повернути (1-25, дефолт 12)." },
        },
      },
    },
    {
      name: "list_categories",
      description: "Перелік категорій користувача (назви верхнього рівня) — щоб знати, за якими значеннями фільтрувати. Виклич, якщо не впевнений у точній назві категорії.",
      input_schema: { type: "object", properties: {} },
    },
  ];
}

function parseToolDate(s: unknown, endOfDay = false): number | null {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
const isoDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

export async function runFinanceTool(env: Env, name: string, input: Record<string, unknown>): Promise<unknown> {
  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null); // завжди ₴

  if (name === "query_spend") {
    const from = parseToolDate(input.from_date);
    const to = parseToolDate(input.to_date, true);
    if (from == null || to == null) return { error: "from_date і to_date мають бути у форматі YYYY-MM-DD" };
    const flow = input.flow === "income" ? "income" : "spend";
    const whereFlow = flow === "income" ? INCOME_WHERE : SPEND_WHERE;
    const sumExpr = flow === "income"
      ? `CAST(ROUND(COALESCE(SUM(t.amount * ${mult}), 0)) AS INTEGER)`
      : amountSum(mult);
    const binds: unknown[] = [from, to];
    const extra: string[] = [];
    if (typeof input.category === "string" && input.category.trim()) { extra.push(`${EFF_CAT_NAME} LIKE ?`); binds.push(`%${input.category.trim()}%`); }
    if (typeof input.merchant === "string" && input.merchant.trim()) { extra.push("t.merchant LIKE ?"); binds.push(`%${input.merchant.trim()}%`); }
    const where = `t.time >= ? AND t.time <= ? AND ${whereFlow}${extra.length ? ` AND ${extra.join(" AND ")}` : ""}`;
    const group = input.group_by;
    if (group === "month" || group === "category" || group === "merchant") {
      const sel = group === "month" ? "strftime('%Y-%m', t.time, 'unixepoch')" : group === "category" ? EFF_CAT_NAME : "COALESCE(t.merchant, 'інше')";
      const grp = group === "category" ? EFF_CAT_ID : sel;
      const order = group === "month" ? "label ASC" : "amt DESC";
      const rows = await env.DB.prepare(
        `SELECT ${sel} AS label, ${sumExpr} AS amt, COUNT(*) AS n FROM transactions t ${STATS_JOINS} WHERE ${where} GROUP BY ${grp} ORDER BY ${order} LIMIT 24`,
      ).bind(...binds).all<{ label: string; amt: number; n: number }>();
      return { flow, from_date: input.from_date, to_date: input.to_date, currency: "UAH", groups: (rows.results ?? []).map((r) => ({ label: r.label, amount_uah: Math.round(r.amt / 100), count: r.n })) };
    }
    const tot = await env.DB.prepare(
      `SELECT ${sumExpr} AS amt, COUNT(*) AS n FROM transactions t ${STATS_JOINS} WHERE ${where}`,
    ).bind(...binds).first<{ amt: number; n: number }>();
    return { flow, from_date: input.from_date, to_date: input.to_date, currency: "UAH", total_uah: Math.round((tot?.amt ?? 0) / 100), count: tot?.n ?? 0 };
  }

  if (name === "find_transactions") {
    const from = parseToolDate(input.from_date);
    const to = parseToolDate(input.to_date, true);
    const parts = ["t.transfer_pair_id IS NULL"];
    const binds: unknown[] = [];
    if (from != null) { parts.push("t.time >= ?"); binds.push(from); }
    if (to != null) { parts.push("t.time <= ?"); binds.push(to); }
    if (input.flow === "spend") parts.push("t.amount < 0");
    else if (input.flow === "income") parts.push("t.amount > 0");
    if (typeof input.category === "string" && input.category.trim()) { parts.push(`${EFF_CAT_NAME} LIKE ?`); binds.push(`%${input.category.trim()}%`); }
    if (typeof input.query === "string" && input.query.trim()) { const q = `%${input.query.trim()}%`; parts.push("(t.merchant LIKE ? OR t.comment LIKE ?)"); binds.push(q, q); }
    if (typeof input.min_amount_uah === "number" && input.min_amount_uah > 0) { parts.push(`ABS(t.amount * ${mult}) >= ?`); binds.push(Math.round(input.min_amount_uah * 100)); }
    const limit = Math.min(Math.max(Math.trunc(Number(input.limit) || 12), 1), 25);
    const rows = await env.DB.prepare(
      `SELECT t.id AS id, t.time AS time, t.merchant AS merchant, t.comment AS comment,
              CAST(ROUND(t.amount * ${mult}) AS INTEGER) AS amt, ${EFF_CAT_NAME} AS cat
       FROM transactions t ${STATS_JOINS} WHERE ${parts.join(" AND ")} ORDER BY t.time DESC LIMIT ?`,
    ).bind(...binds, limit).all<{ id: string; time: number; merchant: string | null; comment: string | null; amt: number; cat: string | null }>();
    return {
      count: rows.results?.length ?? 0,
      transactions: (rows.results ?? []).map((r) => ({
        id: r.id, date: isoDay(r.time), merchant: r.merchant || r.comment || "операція",
        amount_uah: Math.round(r.amt / 100), category: r.cat || "без категорії",
      })),
    };
  }

  if (name === "list_categories") {
    const rows = await env.DB.prepare(
      "SELECT name FROM categories WHERE parent_id IS NULL AND id <> 13 ORDER BY name",
    ).all<{ name: string }>();
    return { categories: (rows.results ?? []).map((r) => r.name) };
  }

  return { error: `невідомий інструмент: ${name}` };
}

// §GR2: спільний контекст групи — тотали, категорії всередині, транзакції (з id).
async function groupPayload(env: Env, eventId: number) {
  const ev = await env.DB.prepare("SELECT id, name, kind, note FROM event_groups WHERE id = ?").bind(eventId)
    .first<{ id: number; name: string; kind: string; note: string | null }>();
  if (!ev) return null;
  const txs = await env.DB.prepare(
    `SELECT t.id, t.merchant, t.comment, t.amount, t.currency_code,
            COALESCE(c.name, 'без категорії') AS cat
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.event_id = ? AND t.currency_code = 980 ORDER BY t.amount ASC`,
  ).bind(eventId).all<TxLabelRow & { cat: string }>();
  const list = txs.results ?? [];
  const spent = list.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
  const income = list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const byCat = new Map<string, number>();
  for (const t of list) if (t.amount < 0) byCat.set(t.cat, (byCat.get(t.cat) ?? 0) - t.amount);

  // Місячний burn + runway для масштабу.
  const now = Math.floor(Date.now() / 1000);
  const { mult: burnMult } = valueMode(await getRates(env.DB), null);
  const burnRow = await env.DB.prepare(
    `SELECT ${spendSum(burnMult)} AS spent FROM transactions t ${STATS_JOINS} WHERE t.time >= ?`,
  ).bind(now - 90 * 86400).first<{ spent: number }>();
  const monthlyBurn = Math.round((burnRow?.spent ?? 0) / 3);
  const ownFunds = await ownFundsUAH(env);
  const runwayMonths = monthlyBurn > 0 ? Math.round((ownFunds / monthlyBurn) * 10) / 10 : null;

  return {
    ev, list,
    payload: {
      period_note: "total_spent_uah/categories.spent_uah — це суми ЗА ВСЮ ГРУПУ (не за місяць). monthly_burn_uah — середні витрати користувача на місяць, лише для масштабу. Не плутай total групи з місячним.",
      name: ev.name, kind: ev.kind, note: ev.note ?? "(без опису)",
      total_spent_uah: Math.round(spent / 100),
      total_income_uah: Math.round(income / 100),
      tx_count: list.length,
      monthly_burn_uah: Math.round(monthlyBurn / 100),
      runway_months: runwayMonths,
      categories: [...byCat.entries()].map(([name, v]) => ({ name, spent_uah: Math.round(v / 100) })).sort((a, b) => b.spent_uah - a.spent_uah),
      transactions: list.map(txLabel),
    },
  };
}

export async function evaluateGroupAdvice(env: Env, eventId: number): Promise<StructuredInsight | null> {
  const g = await groupPayload(env, eventId);
  if (!g) return null;
  const { result, usage } = await evaluateGroup(env, g.payload);
  logUsage("group-eval", usage);
  return result;
}

// Чат по конкретній групі — контекст = дані групи (тотали, категорії, транзакції з id).
export async function chatAboutGroup(env: Env, eventId: number, messages: ChatMsg[]): Promise<{ reply: string }> {
  const g = await groupPayload(env, eventId);
  if (!g) return { reply: "Групу не знайдено." };
  const context = { group: g.payload, transactions: g.payload.transactions };
  const { text, usage } = await chatAdvice(env, context, messages);
  logUsage("group-chat", usage);
  return { reply: text };
}

// Інлайн-чат по КОНКРЕТНІЙ операції: людяна відповідь + опційне застосування зміни
// (категорія / прапорець переказу), коли з розмови стало однозначно ясно, що це.
export interface TxChatApplied { category_id?: number | null; category_name?: string | null; is_transfer?: boolean; understanding?: string }
export async function chatAboutTx(
  env: Env,
  id: string,
  messages: ChatMsg[],
): Promise<{ reply: string; applied?: TxChatApplied }> {
  const tx = await env.DB.prepare(
    `SELECT t.id, t.merchant, t.comment, t.mcc, t.amount, t.currency_code, t.category_id,
            t.is_transfer, t.user_note, c.name AS category_name
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?`,
  ).bind(id).first<{
    id: string; merchant: string | null; comment: string | null; mcc: number | null;
    amount: number; currency_code: number; category_id: number | null; is_transfer: number;
    user_note: string | null; category_name: string | null;
  }>();
  if (!tx) return { reply: "Операцію не знайдено." };

  const tags = await env.DB.prepare(
    `SELECT c.name FROM transaction_tags tt JOIN categories c ON c.id = tt.category_id WHERE tt.transaction_id = ?`,
  ).bind(id).all<{ name: string }>();

  const ctx = {
    name: tx.merchant ?? tx.comment ?? "операція",
    bank_comment: tx.comment,
    mcc: tx.mcc,
    amount: Math.round(tx.amount / 100),
    currency_code: tx.currency_code,
    sign: tx.amount < 0 ? "витрата" : "надходження",
    current_category: tx.category_name ?? "без категорії",
    current_category_id: tx.category_id,
    is_transfer: !!tx.is_transfer,
    tags: (tags.results ?? []).map((t) => t.name),
    user_note: tx.user_note ?? null,
    user_profile: (await getProfile(env)) || null,
  };

  const { result, usage } = await txChat(env, ctx, messages);
  logUsage("tx-chat", usage);

  const applied: TxChatApplied = {};
  // Категорію міняємо, лише якщо AI явно повернув інший валідний id.
  if (result.category_id != null && result.category_id !== tx.category_id) {
    const cat = await env.DB.prepare("SELECT name FROM categories WHERE id = ?")
      .bind(result.category_id).first<{ name: string }>();
    if (cat) {
      await env.DB.prepare("UPDATE transactions SET category_id = ? WHERE id = ?").bind(result.category_id, id).run();
      applied.category_id = result.category_id;
      applied.category_name = cat.name;
    }
  }
  if (result.is_transfer !== undefined && !!result.is_transfer !== !!tx.is_transfer) {
    await env.DB.prepare("UPDATE transactions SET is_transfer = ? WHERE id = ?").bind(result.is_transfer ? 1 : 0, id).run();
    applied.is_transfer = !!result.is_transfer;
  }
  // §Хвіст: чат оновлює «AI розуміє це як» (ai_note). txChat повертає уточнене understanding —
  // раніше воно викидалось, тож пояснення в чаті («це моя зарплата з крипти») не приживалось на
  // екрані. Тепер персистимо, щоб рядок відображав актуальне розуміння після розмови.
  const understanding = result.understanding?.trim();
  if (understanding) {
    await env.DB.prepare("UPDATE transactions SET ai_note = ? WHERE id = ?").bind(understanding, id).run();
    applied.understanding = understanding;
  }

  return { reply: result.reply, applied: Object.keys(applied).length ? applied : undefined };
}
