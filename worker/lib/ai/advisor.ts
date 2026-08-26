// AI-порадник (структурований): рахуємо runway із власних коштів і місячного burn,
// подаємо разом із профілем ситуації в Haiku → поради-картки. Кешуємо в app_state.
import type { Env } from "../../env.ts";
import type { ChatMsg, OnText } from "./ai.ts";
import { type BudgetChatResult, budgetChat, chatAdvice } from "./tasks.ts";
import { type AdviceResult, type AiFact, evaluateGroup, generateAdvice, proposeBudgetLimits } from "./generate.ts";
import { briefUsage, logUsage, type AiUsageBrief } from "./cost.ts";
import type { StructuredInsight } from "./insight.ts";
import type { AdviceHistoryItem } from "../../../shared/api/ai.ts";
import { getState, setState } from "../finance/repo.ts";
import { toBaseMinor, getRates, resolveBaseCurrency, uahToBase, type Rates } from "../finance/money.ts";
import { currencySign } from "../../../shared/currency.ts";
import { monthlyPlannedUAH, sumMonthlyPlannedUAH } from "../finance/subscriptions.ts";
import { STATS_JOINS, EFF_AMOUNT, EFF_CAT_ID, EFF_CAT_NAME, EFF_CAT_COLOR, EFF_IMPORTANCE, SPEND_WHERE, valueMode, spendSum, incomeSum, amountSum, recurringOneoffSplit, categoryMonthlyLevels, sumLevels, localMonthStart, localYmSql, localYm, localYmd } from "../finance/stats.ts";
import { catNameSql } from "../finance/categories-i18n.ts";
import { financeChatTools, runFinanceTool } from "./chat-tools.ts";
import { ownFundsMinor } from "../finance/own-funds.ts";
import { buildWeekdayAnalytics } from "../finance/weekday.ts";
import { buildTimeContext, buildUpcomingCharges } from "./time-context.ts";
import * as analyticsRepo from "../../repo/analytics.ts";
import { st, stLit, num, resolveLocale } from "../platform/i18n.ts";

// Короткий підпис транзакції для чипів/цитування AI: мерчант + сума (major) у ₴.
interface TxLabelRow { id: string; merchant: string | null; comment: string | null; amount: number; currency_code: number }
function txLabel(t: TxLabelRow): { id: string; label: string } {
  const name = (t.merchant || t.comment || "operation").slice(0, 24);
  const sign = currencySign(t.currency_code);
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
  /**
   * §BASE-CUR — the currency every figure in this advice is in, stamped when it was generated.
   * Advice is STORED and re-read for a month; signing yesterday's numbers with today's currency
   * would put one currency's sign in front of another's amount (the same reason the notification
   * feed and a saved report carry theirs). Absent on advice written before the setting: hryvnia.
   */
  cur?: number;
  /** true — порада зібрана детерміновано з чисел, БЕЗ AI (див. `fallbackAdvice`). */
  fallback?: boolean;
  /** Чому впали у fallback — показуємо користувачу, а не глушимо (§Обробка помилок). */
  fallback_reason?: string;
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
/**
 * §R3 — the canonical split of "where the money is", shared by the adviser, the chat and the
 * Accounts overview.
 *
 * `ratesIn` (§D5): pass the snapshot you have already read. Two callers below load rates and then
 * call this in the SAME `Promise.all`, which was two reads of one row per request — and, in
 * principle, two DIFFERENT rate snapshots inside one answer if the hourly cron landed between
 * them. Optional rather than required so the many one-shot callers stay one line.
 */
export async function fundsBreakdown(env: Env, ratesIn?: Rates): Promise<FundsBreakdown> {
  const accounts = await env.DB.prepare(
    "SELECT title, type, role, ai_note, balance, credit_limit, currency_code FROM accounts WHERE is_active = 1",
  ).all<{ title: string | null; type: string | null; role: string | null; ai_note: string | null; balance: number; credit_limit: number; currency_code: number }>();
  const rates = ratesIn ?? await getRates(env);
  let cushion = 0, debt = 0, investment = 0;
  const list: AccountFunds[] = [];
  for (const a of accounts.results ?? []) {
    const own = toBaseMinor(ownFundsMinor(a.balance, a.credit_limit), a.currency_code, rates);
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

async function ownFundsUAH(env: Env, ratesIn?: Rates): Promise<number> {
  return (await fundsBreakdown(env, ratesIn)).net;
}

// §H (2026-07-19): детермінований «Індекс фінздоров'я» 0..100 — БЕЗ AI. Чотири складові з
// канонічних чисел (stats): runway, норма заощаджень, борг/дохід, стабільність доходу.
// Дефолтна (проста, прозора) реалізація — далі можна уточнювати ваги/криві.
export interface HealthComponent { key: string; label: string; value: string; score: number; hint: string }
export interface FinanceHealth { score: number; band: "good" | "ok" | "risk"; components: HealthComponent[] }
export async function financeHealth(env: Env): Promise<FinanceHealth> {
  const now = Math.floor(Date.now() / 1000);

  const from6 = localMonthStart(now, -6);
  const monthStart = localMonthStart(now);
  // One snapshot for the whole answer (§D5) — health mixes funds with spending levels, and the
  // two halves resting on different rates would be a disagreement nobody could see.
  const rates = await getRates(env);
  const { mult } = valueMode(rates, null);
  const [funds, levels, incomeRows] = await Promise.all([
    fundsBreakdown(env, rates),
    categoryMonthlyLevels(env, mult, { now }),
    // Дохід по ПОВНИХ місяцях (поточний частковий виключено) — для норми/стабільності.
    env.DB.prepare(
      `SELECT ${localYmSql(now)} AS m, ${incomeSum(mult)} AS income
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time < ? GROUP BY m ORDER BY m`,
    ).bind(from6, monthStart).all<{ m: string; income: number }>(),
  ]);

  const burn = sumLevels(levels); // ₴-мінор/міс (канон)
  const incomes = (incomeRows.results ?? []).map((r) => r.income).filter((v) => v > 0);
  const avgIncome = incomes.length ? incomes.reduce((s, v) => s + v, 0) / incomes.length : 0;
  const runway = burn > 0 ? funds.cushion / burn : (funds.cushion > 0 ? 12 : 0);
  const savingsRate = avgIncome > 0 ? (avgIncome - burn) / avgIncome : 0;
  const debtRatio = avgIncome > 0 ? funds.debt / avgIncome : (funds.debt > 0 ? 3 : 0);
  const mean = incomes.length ? incomes.reduce((s, v) => s + v, 0) / incomes.length : 0;
  const cv = mean > 0 && incomes.length > 1
    ? Math.sqrt(incomes.reduce((s, v) => s + (v - mean) ** 2, 0) / incomes.length) / mean : 0;

  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const sRunway = clamp01(runway / 6);          // 6 міс подушки = максимум
  const sSavings = clamp01(savingsRate / 0.2);  // 20%+ = максимум
  const sDebt = funds.debt <= 0 ? 1 : clamp01(1 - debtRatio / 3); // 3 міс доходу боргу = 0
  const sStable = clamp01(1 - cv);
  const score = Math.round((sRunway * 0.35 + sSavings * 0.30 + sDebt * 0.20 + sStable * 0.15) * 100);
  const band: FinanceHealth["band"] = score >= 70 ? "good" : score >= 45 ? "ok" : "risk";

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  // Labels and hints are rendered as-is by `HealthIndexCard`/`HealthMini`, so they follow the
  // reader's locale like any other UI string (B3).
  const loc = await resolveLocale(env);
  return {
    score, band,
    components: [
      { key: "runway", label: st(loc, "healthRunway"), value: runway >= 12 ? st(loc, "healthMonthsMax") : st(loc, "healthMonths", { n: Math.round(runway * 10) / 10 }), score: Math.round(sRunway * 100), hint: st(loc, "healthRunwayHint") },
      { key: "savings", label: st(loc, "healthSavings"), value: pct(savingsRate), score: Math.round(sSavings * 100), hint: st(loc, "healthSavingsHint") },
      { key: "debt", label: st(loc, "healthDebt"), value: funds.debt <= 0 ? st(loc, "healthNoDebt") : st(loc, "healthDebtRatio", { n: Math.round(debtRatio * 10) / 10 }), score: Math.round(sDebt * 100), hint: st(loc, "healthDebtHint") },
      { key: "stability", label: st(loc, "healthStability"), value: pct(1 - cv), score: Math.round(sStable * 100), hint: st(loc, "healthStabilityHint") },
    ],
  };
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
  /** §TIME-CTX: the day numbers and months this payload STATES — the calendar a model answer is checked against. */
  timeAnchors: { days: number[]; months: number[] };
}

export async function collectFinanceSnapshot(env: Env, ratesIn?: Rates): Promise<FinanceSnapshot> {
  const now = Math.floor(Date.now() / 1000);
  const from90 = now - 90 * 86400;
  /**
   * Category names go to the model in the READER's language, exactly as they go to the screen.
   *
   * They did not, and that was half the "the AI answers in Ukrainian" report: `repo/*` wraps every
   * name in `catNameSql` for the API, while this snapshot selected the raw stored name. So the
   * screen said "Groceries" and the model was handed «Продукти» — a second resolution of one
   * concept, diverging exactly where the reader can see it (the same shape as §CUR-PLAN). It also
   * meant even a perfectly English answer named its categories in Ukrainian.
   */
  const loc = await resolveLocale(env);
  const CAT_NAME = catNameSql(loc, EFF_CAT_NAME);

  const monthStart = localMonthStart(now);
  const from6mo = localMonthStart(now, -5);
  const prevMonthStart = localMonthStart(now, -1);

  const rates = ratesIn ?? await getRates(env); // §D5: приймаємо вже прочитаний знімок
  const { mult } = valueMode(rates, null); // канонічно, зведено в ₴
  const [funds, levels, cats, merchants, events, importance, trend, budgetRows, monthByCat, prevMonthByCat, subsAgg, split, upcomingRows, weekdayRows] = await Promise.all([
    fundsBreakdown(env, rates), // §D5: той самий знімок курсів, що й решта цього контексту
    // P1: канонічний місячний рівень категорій — джерело і для avg_month, і для burn (sumLevels).
    categoryMonthlyLevels(env, mult, { now }),
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, ${CAT_NAME} AS name, ${amountSum(mult)} AS spent
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
      `SELECT e.name AS name, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS} JOIN event_groups e ON e.id = t.event_id
       WHERE t.time >= ? AND ${EFF_AMOUNT} < 0 AND t.is_transfer = 0
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
      `SELECT ${localYmSql(now)} AS m, ${spendSum(mult)} AS spend, ${incomeSum(mult)} AS income
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? GROUP BY m ORDER BY m`,
    ).bind(from6mo).all<{ m: string; spend: number; income: number }>(),
    // §2: бюджети (ліміт на місяць) + факт за цей місяць → over/under.
    env.DB.prepare(
      `SELECT b.category_id AS id, ${catNameSql(loc, "c.name")} AS name, b.amount AS lim
       FROM budgets b JOIN categories c ON c.id = b.category_id WHERE b.period = 'month'`,
    ).all<{ id: number; name: string; lim: number }>(),
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND ${SPEND_WHERE} GROUP BY ${EFF_CAT_ID}`,
    ).bind(monthStart).all<{ id: number; spent: number }>(),
    // Той самий зріз за ПОВНИЙ попередній місяць — щоб «на що пішла різниця» була рахунком,
    // а не здогадом моделі. Той самий канон, інші межі; порівнюємо ПОРІВНЯННИЙ відрізок
    // (стільки ж днів від початку місяця), інакше 1 серпня різниця = «місяць ще не почався».
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, ${CAT_NAME} AS name, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time < ? AND ${SPEND_WHERE} GROUP BY ${EFF_CAT_ID}`,
    ).bind(prevMonthStart, prevMonthStart + (now - monthStart)).all<{ id: number; name: string | null; spent: number }>(),
    // §2: фіксовані зобовʼязання — активні плани самі, а не одна SUM.
    // §SUB-MONTH: місячний тягар рахує `monthlyPlannedUAH` у JS (квартальний план = третина
    // суми на місяць, тижневий ≈ 4.3 суми). SQL-сума `period_amount` цього не вміла.
    // Категорія їде разом із планом: користувач тримає підписки не лише в «Підписках»
    // (Anthropic — «Софт», інтернет — «Комуналка»), і без цього списку модель бачила лише
    // категорію «Підписки» й називала підписками саме її вміст (скарга користувача).
    env.DB.prepare(
      `SELECT p.title, p.kind, p.period_amount, p.currency_code, p.period, p.period_count,
              p.start_date, p.end_date, ${catNameSql(loc, "c.name")} AS category
       FROM planned_payments p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = 1`,
    ).all<{
      title: string; kind: string; period_amount: number | null; currency_code: number | null;
      period: string; period_count: number | null; start_date: number; end_date: number | null;
      category: string | null;
    }>(),
    // §E1/C: разові vs регулярні за поточний місяць — щоб AI не проектував разове як норму.
    recurringOneoffSplit(env, monthStart, now, mult),
    // §CTX: найближчі планові списання (для «коли платити») — рахуємо nextChargeUnix у JS.
    env.DB.prepare(
      `SELECT title, period, period_count, start_date, period_amount, currency_code, kind FROM planned_payments WHERE is_active = 1`,
    ).all<{ title: string; period: string; period_count: number; start_date: number; period_amount: number | null; currency_code: number | null; kind: string }>(),
    // §WEEKDAY: коли саме йдуть гроші. Той самий репозиторій, що живить екран — інакше порадник
    // і Статистика назвали б різні «найдорожчі дні», що для читача виглядає як помилка в одному
    // з них, а насправді є двома визначеннями одного числа.
    analyticsRepo.spendByWeekday(env.DB, { mult, curFilter: "" }, { from: from90, to: now }, now),
  ]);

  const weekday = buildWeekdayAnalytics(weekdayRows, from90, now);
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
  // §SUB-MONTH: усереднений місячний тягар планів (канон). Список — щоб модель могла назвати
  // конкретні підписки, а не переказувати категорію.
  const subsPlans = (subsAgg.results ?? []).filter((p) => monthlyPlannedUAH(p, rates, now) > 0);
  const subsMonthly = Math.round(sumMonthlyPlannedUAH(subsPlans, rates, now) / 100);
  const subsItems = subsPlans
    .map((p) => ({
      title: p.title,
      monthly_uah: Math.round(monthlyPlannedUAH(p, rates, now) / 100),
      category: p.category,
      kind: p.kind,
      period: (p.period_count ?? 1) > 1 ? `${p.period}×${p.period_count}` : p.period,
    }))
    .sort((a, b) => b.monthly_uah - a.monthly_uah)
    .slice(0, 20);
  // `levels` (канонічний місячний рівень) уже завантажено вище в Promise.all — джерело avg_month і burn.
  const catAvgMonth = (id: number, spent90: number) => Math.round((levels.get(id)?.level ?? spent90 / 3) / 100);
  // §2/§5: найбільші операції з id — щоб AI цитував конкретику токеном [tx:ID].
  const citable = await notableTransactions(env, 90, 12);

  // §CTX/§TIME-CTX: the nearest charges — the app's whole answer to "when" (see `time-context.ts`).
  const upcoming = buildUpcomingCharges(upcomingRows.results ?? [], rates, now);

  // §TIME-CTX: today, the runway in days, and the anchors an AI answer is checked against.
  const timeCtx = buildTimeContext(
    now, upcoming, runwayMonths, (trend.results ?? []).map((t) => String(t.m)),
  );

  // §A1: активні факти про світ (наратив). Тут — ЄДИНЕ джерело контексту, тож і Порадник,
  // і Чат бачать факти автоматом (не додаємо їх у чат окремо). applied_to_numbers показує,
  // чи факт уже рухає burn/runway (лише підтверджений факт з коригуванням) — щоб AI не плутав
  // «пояснив» із «порахував».
  const facts = await activeFacts(env, now);

  // §ADV-METRICS (2026-08-01) — три числа, яких у пораді бракувало, і які модель інакше або
  // не називала, або вигадувала. Усі рахуються ТУТ, детерміновано, з тих самих канонічних сум.
  const advLoc = await resolveLocale(env);
  const monthKey = localYm(now);
  const thisMonth = (trend.results ?? []).find((r) => r.m === monthKey);
  const mIncome = thisMonth?.income ?? 0, mSpend = thisMonth?.spend ?? 0;
  // Норма заощаджень МІСЯЦЯ-ДО-ДАТИ. null при нульовому доході — «−∞%» не число, а шум.
  const savingsRatePct = mIncome > 0 ? Math.round(((mIncome - mSpend) / mIncome) * 100) : null;

  // Куди пішла різниця vs той самий відрізок минулого місяця. Сортуємо за |дельтою|, бо
  // цікаве і зростання, і падіння: категорія, що впала на 5к, пояснює місяць так само добре.
  const prevByCat = new Map((prevMonthByCat.results ?? []).map((r) => [r.id, { spent: Math.abs(r.spent), name: r.name }]));
  const nameById = new Map<number, string>();
  for (const r of cats.results ?? []) if (r.id != null) nameById.set(r.id, r.name ?? "");
  for (const [id, v] of prevByCat) if (v.name) nameById.set(id, v.name);
  const drivers = [...new Set([...monthSpent.keys(), ...prevByCat.keys()])]
    .map((id) => {
      const cur = monthSpent.get(id) ?? 0;
      const prev = prevByCat.get(id)?.spent ?? 0;
      return { category: nameById.get(id) ?? st(advLoc, "uncategorized"), delta_uah: Math.round((cur - prev) / 100), now_uah: Math.round(cur / 100), prev_uah: Math.round(prev / 100) };
    })
    .filter((d) => d.delta_uah !== 0)
    .sort((a, b) => Math.abs(b.delta_uah) - Math.abs(a.delta_uah))
    .slice(0, 5);

  const context: Record<string, unknown> = {
    period_note: "top_categories/top_merchants/by_event hold totals for the LAST 90 DAYS (3 months); avg_month_uah is the monthly average. monthly_burn_uah is average spending per month. Do NOT confuse the 90-day total with a monthly one — rely on avg_month_uah. by_importance: essential (do not cut), discretionary (wanted), optional (safest to cut). monthly_trend: spend and income by month (6 months) — read the dynamics and seasonality, not just the average. budgets: limit vs actual this month (used_pct>100 means overspent — highlight it). subscriptions_monthly_uah: fixed subscriptions per month (near-constant). upcoming_charges: the nearest charges (in_days) — use them for advice on timing and payment priority. recent_oneoff holds this month's ONE-OFF expenses (taxes, doctor, a large purchase): do NOT project them as recurring. Cite specifics: categories, subscriptions, budgets.",
    period_days: 90,
    ...timeCtx.fields,
    situation: profile || "(not specified)",
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
    accounts_note: "accounts lists the user's accounts with their role and DESCRIPTION (note). role='investment' (crypto, brokerage) is NOT part of the cushion by default (it stays out of liquid_cushion and runway), but it is the last line for an extreme case. Take each account's note into account. Do not propose selling investments unless the situation is critical.",
    runway_note: "runway_months = liquid cushion / monthly burn (how long the real money lasts WITHOUT investments). Base it on the cushion, not on the net figure.",
    monthly_burn_uah: Math.round(monthlyBurn / 100),
    runway_months: runwayMonths,
    recent_oneoff: {
      total_uah: Math.round(split.oneoff.spent / 100),
      items: split.oneoff_items.map((o) => ({ merchant: o.merchant, category: o.category, amount_uah: Math.round(o.amount / 100) })),
    },
    // §ADV-METRICS: показники САМЕ цього місяця (не 90д) — модель раніше або мовчала про них,
    // або називала на око.
    this_month: {
      income_uah: Math.round(mIncome / 100),
      spend_uah: Math.round(mSpend / 100),
      savings_rate_pct: savingsRatePct,
      vs_prev_month_uah: Math.round((mSpend - [...prevByCat.values()].reduce((s2, v) => s2 + v.spent, 0)) / 100),
      drivers,
    },
    this_month_note: "this_month is the current month UP TO TODAY, compared against THE SAME stretch of last month (the same number of days from the 1st), so vs_prev_month_uah and drivers are a fair comparison rather than a full month against a partial one. savings_rate_pct=null means income was zero this month — say exactly that, do not write −100%. drivers shows where the DIFFERENCE went (+ means more was spent): name the top one or two explicitly, it is the single most useful sentence in the whole piece of advice.",
    subscriptions_monthly_uah: subsMonthly,
    subscriptions_count: subsPlans.length,
    subscriptions: subsItems,
    subscriptions_note: "subscriptions holds the user's DECLARED recurring payments (planned_payments) with their category; monthly_uah is already averaged per month (a quarterly plan is a third of the amount, a weekly one about 4.3×). ⚠️ A subscription is NOT the same as the subscriptions CATEGORY: internet may sit under utilities, cloud services under software, insurance under health. When talking about recurring payments, rely on this list and on subscriptions_monthly_uah, NOT on the subscriptions category total in top_categories — that is smaller and describes something else.",
    upcoming_charges: upcoming,
    // §WEEKDAY: типовий день тижня за 90 днів. `lumpy` дні модель має ІГНОРУВАТИ як поведінку —
    // це дата списання оренди, а не звичка; прапорець їде разом із числом саме тому.
    weekday: weekday.days.map((d) => ({
      dow: d.dow, typical_uah: Math.round(d.typical / 100), operations: d.n, one_payment: d.lumpy,
    })),
    weekday_note: "weekday holds spending by day of week over 90 days; dow: 0=Sunday … 6=Saturday. typical_uah is the AVERAGE for such a day (the total divided by how many such days fall in the window), so the days are comparable with each other. ⚠️ one_payment=true means nearly the whole day's amount is ONE payment (rent, a tax): that is about the charge date, not about behaviour — do not call such a day expensive and do not advise spending less on those days. Read busiest_day and weekend_share only from days where one_payment=false.",
    top_categories: (cats.results ?? []).map((c) => ({ id: c.id, name: c.name, spent_90d_uah: Math.round(c.spent / 100), avg_month_uah: catAvgMonth(c.id, c.spent) })),
    top_merchants: (merchants.results ?? []).map((m) => ({ merchant: m.merchant, spent_90d_uah: Math.round(m.spent / 100), avg_month_uah: Math.round(m.spent / 3 / 100) })),
    by_event: (events.results ?? []).map((e) => ({ event: e.name, spent_90d_uah: Math.round(e.spent / 100), avg_month_uah: Math.round(e.spent / 3 / 100) })),
    by_importance: (importance.results ?? []).map((x) => ({ level: x.importance, spent_90d_uah: Math.round(x.spent / 100) })),
    monthly_trend: (trend.results ?? []).map((t) => ({ month: t.m, spend_uah: Math.round(t.spend / 100), income_uah: Math.round(t.income / 100) })),
    budgets,
  };
  if (facts.length) {
    context.facts = facts;
    context.facts_note = "facts holds facts about the world that the user told you (e.g. \"the metro fare rose from 8 to 30 UAH\", \"I left my job\"). Take them into account in your explanations and forecast. applied_to_numbers=true means the fact is ALREADY reflected in avg_month_uah, monthly_burn and runway — do not add its effect a second time. applied_to_numbers=false means the fact is explanatory only (unconfirmed, or carrying no amount adjustment): mention it in words, but do NOT change the figures yet.";
  }

  return { now, funds, ownFunds, monthlyBurn, runwayMonths, subsMonthly, citable, context, timeAnchors: timeCtx.anchors };
}

// §A1: активні факти на `now` (наратив для снапшота). Повертає []-безпечно, якщо таблиці ще нема.
export interface ActiveFact { text: string; since: string; until: string | null; category: string | null; applied_to_numbers: boolean }
async function activeFacts(env: Env, now: number): Promise<ActiveFact[]> {
  const loc = await resolveLocale(env);
  try {
    const rows = await env.DB.prepare(
      `SELECT f.text AS text, f.effective_from AS ef, f.expires_at AS ex, f.confirmed_at AS cf,
              f.adjust_kind AS kind, ${catNameSql(loc, "c.name")} AS cat
       FROM facts f LEFT JOIN categories c ON c.id = f.category_id
       WHERE f.effective_from <= ? AND (f.expires_at IS NULL OR f.expires_at > ?)
       ORDER BY f.effective_from DESC LIMIT 20`,
    ).bind(now, now).all<{ text: string; ef: number; ex: number | null; cf: number | null; kind: string | null; cat: string | null }>();
    // §APP_TZ: the dates handed to the model are the reader's, so «сьогодні» in the answer and
    // «сьогодні» on the screen are the same day. UTC drifts one day back every night until 03:00.
    const iso = (u: number) => localYmd(u);
    return (rows.results ?? []).map((r) => ({
      text: r.text,
      since: iso(r.ef),
      until: r.ex != null ? iso(r.ex) : null,
      category: r.cat,
      applied_to_numbers: r.cf != null && r.kind != null,
    }));
  } catch {
    return [];
  }
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
    cur: await resolveBaseCurrency(env),
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
      cur: stored.cur,        // §BASE-CUR: a delta against a snapshot in another unit is not a delta
    });
    await setState(env.DB, "advisor_history", JSON.stringify(hist.slice(0, 24)));
  } catch { /* історія не критична */ }

  return stored;
}

/**
 * Детермінований fallback поради — коли AI недоступний (нема ключа, ліміт, збій моделі).
 *
 * Правило §Обробка помилок: краще ДЕГРАДУВАТИ, ніж мовчати. Порожня сторінка не відрізняється
 * від «нема даних», тож користувач не знає, чи щось зламалось. Тут — ті самі канонічні числа
 * (`collectFinanceSnapshot`), просто складені без моделі: подушка, burn, runway, найбільша
 * категорія, необовʼязкові витрати, перевитрачені бюджети, найближчі списання.
 *
 * ⚠️ НЕ зберігаємо в `app_state.advisor` і НЕ пишемо в історію: інакше слабша детермінована
 * порада затерла б останню нормальну AI-пораду, і користувач мовчки втратив би кращий результат.
 */
export async function fallbackAdvice(env: Env, reason?: string): Promise<StoredAdvice> {
  const snap = await collectFinanceSnapshot(env);
  const { funds, ownFunds, monthlyBurn, runwayMonths, subsMonthly, context } = snap;
  // This whole block is rendered verbatim on the Advisor screen — including for a demo visitor
  // whose AI budget ran out — so it is localized, digit grouping included (B3).
  const loc = await resolveLocale(env);
  const uah = (minor: number) => Math.round(minor / 100);
  const n = (v: number) => num(loc, v);
  // §BASE-CUR: one symbol, resolved once, threaded into every template below as `cur`.
  const cur = currencySign(await resolveBaseCurrency(env));
  const fmt = (minor: number) => (loc === "uk" ? `${n(uah(minor))} ${cur}` : `${cur}${n(uah(minor))}`);

  type Cat = { id: number; name: string; avg_month_uah: number };
  const cats = (context.top_categories as Cat[] | undefined) ?? [];
  const budgets = (context.budgets as { category: string; used_pct: number | null }[] | undefined) ?? [];
  const importance = (context.by_importance as { level: string; spent_90d_uah: number }[] | undefined) ?? [];
  const upcoming = (context.upcoming_charges as { title: string; in_days: number; amount_uah: number }[] | undefined) ?? [];

  const runwayText = runwayMonths == null
    ? st(loc, "advRunwayTooLittle")
    : st(loc, "advRunwayText", { cushion: fmt(funds.cushion), months: runwayMonths.toFixed(1), burn: fmt(monthlyBurn) });

  const suggestions: AdviceResult["suggestions"] = [];

  // 1. Найбільша категорія — найбільший важіль. Ефект рахуємо явно, щоб порада була дієвою.
  const top = cats[0];
  if (top && top.avg_month_uah > 0) {
    const cut = Math.round(top.avg_month_uah * 0.15);
    suggestions.push({
      title: st(loc, "advTopCatTitle", { name: top.name }),
      detail: st(loc, "advTopCatDetail", { cur, avg: n(top.avg_month_uah), cut: n(cut), year: n(cut * 12) }),
      action: { type: "create_budget", label: st(loc, "advTopCatAction", { cur, amount: n(top.avg_month_uah - cut), name: top.name }), category_id: top.id, category_name: top.name, amount_uah: top.avg_month_uah - cut },
    });
  }

  // 2. Необовʼязкові витрати — найбезпечніше, що можна різати (§6 вагомість).
  const optional = importance.find((x) => x.level === "optional");
  if (optional && optional.spent_90d_uah > 0) {
    suggestions.push({
      title: st(loc, "advOptionalTitle"),
      detail: st(loc, "advOptionalDetail", { cur, sum: n(optional.spent_90d_uah), perMonth: n(Math.round(optional.spent_90d_uah / 3)) }),
      action: null,
    });
  }

  // 3. Перевитрачені бюджети — конкретний факт, а не абстракція.
  const over = budgets.filter((b) => (b.used_pct ?? 0) > 100);
  if (over.length) {
    suggestions.push({
      title: over.length === 1 ? st(loc, "advBudgetOverOne", { category: over[0].category }) : st(loc, "advBudgetOverMany", { n: over.length }),
      detail: over.map((b) => `${b.category} — ${b.used_pct}%`).join(" · ") + st(loc, "advBudgetOverTail"),
      action: null,
    });
  }

  // 4. Підписки — фіксований відтік, який легко не помічати.
  if (subsMonthly > 0) {
    suggestions.push({
      title: st(loc, "advSubsTitle"),
      detail: st(loc, "advSubsDetail", { cur, month: n(subsMonthly), year: n(subsMonthly * 12) }),
      action: null,
    });
  }

  // 5. Найближчі списання — тайминг, а не тільки суми.
  const soon = upcoming.filter((u) => u.in_days <= 7);
  if (soon.length) {
    const total = soon.reduce((s, u) => s + u.amount_uah, 0);
    suggestions.push({
      title: st(loc, "advUpcomingTitle", { cur, total: n(total) }),
      detail: soon.slice(0, 4).map((u) => st(loc, "advUpcomingItem", { cur, title: u.title, amount: n(u.amount_uah), days: u.in_days })).join(" · "),
      action: null,
    });
  }

  if (!suggestions.length) {
    suggestions.push({
      title: st(loc, "advEmptyTitle"),
      detail: st(loc, "advEmptyDetail"),
      action: null,
    });
  }

  const facts: AiFact[] = [
    { label: st(loc, "advFactCushion"), amount: uah(funds.cushion), category: null, delta_pct: null, tone: funds.cushion > 0 ? "pos" : "neg" },
    { label: st(loc, "advFactBurn"), amount: uah(monthlyBurn), category: null, delta_pct: null, tone: "neutral" },
  ];
  if (funds.debt > 0) facts.push({ label: st(loc, "advFactDebt"), amount: uah(funds.debt), category: null, delta_pct: null, tone: "neg" });
  if (top) facts.push({ label: st(loc, "advFactTopCat"), amount: top.avg_month_uah, category: top.name, delta_pct: null, tone: "neutral" });

  return {
    runway_comment: runwayText,
    summary: st(loc, "advSummary"),
    facts,
    suggestions: suggestions.slice(0, 5),
    own_funds: ownFunds,
    cushion: funds.cushion,
    debt: funds.debt,
    investment: funds.investment,
    monthly_burn: monthlyBurn,
    runway_months: runwayMonths,
    generated_at: snap.now,
    cur: await resolveBaseCurrency(env),
    fallback: true,
    fallback_reason: reason,
  };
}

export type { AdviceHistoryItem };
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
  const loc = await resolveLocale(env);
  const now = Math.floor(Date.now() / 1000);
  const from90 = now - 90 * 86400;

  const rates = await getRates(env);
  const { mult } = valueMode(rates, null);
  const [ownFunds, spendRows, budgetRows] = await Promise.all([
    ownFundsUAH(env, rates),
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS category_id, ${catNameSql(loc, EFF_CAT_NAME)} AS name, ${EFF_CAT_COLOR} AS color, ${amountSum(mult)} AS spent
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
    situation: (await getProfile(env)) || "(not specified)",
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
  const loc = await resolveLocale(env);
  const now = Math.floor(Date.now() / 1000);
  const from90 = now - 90 * 86400;
  const rates = await getRates(env);
  const { mult } = valueMode(rates, null);
  const [ownFunds, spendRows, budgetRows] = await Promise.all([
    ownFundsUAH(env, rates),
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, ${catNameSql(loc, EFF_CAT_NAME)} AS name, ${amountSum(mult)} AS spent, ${EFF_IMPORTANCE} AS importance
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
    situation: (await getProfile(env)) || "(not specified)",
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
export async function chatReply(
  env: Env,
  messages: ChatMsg[],
  attachedTxIds: string[] = [],
  // Present when the caller is streaming the answer to a reader (see `routes/api/advisor.ts`).
  // The full text is still returned exactly as before — streaming adds a second delivery of the
  // same words, it does not replace the return value.
  onText?: OnText,
): Promise<{ reply: string }> {
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
    onText,
  });
  logUsage("chat", usage);
  return { reply: text };
}

// §GR2: спільний контекст групи — тотали, категорії всередині, транзакції (з id).
async function groupPayload(env: Env, eventId: number) {
  const ev = await env.DB.prepare(
    "SELECT id, name, kind, note, budget, goal_id FROM event_groups WHERE id = ?",
  ).bind(eventId)
    .first<{ id: number; name: string; kind: string; note: string | null; budget: number | null; goal_id: number | null }>();
  if (!ev) return null;

  /**
   * §EVENT-GOAL — the money SET ASIDE for this undertaking, when a goal is linked.
   *
   * Without it the model could only ever say how much was spent, which makes every trip look
   * expensive. "Spent 61 000 against 70 000 you had saved" is a different sentence from "spent
   * 61 000", and it is the one the person actually planned around. The goal's own progress is the
   * canon (`current_amount`, or the jar's account balance — the same rule `/goals` applies), so
   * the close-out cannot quote a figure the goal card contradicts.
   */
  const goal = ev.goal_id == null ? null : await env.DB.prepare(
    `SELECT g.name, g.target_amount,
            COALESCE(a.balance, g.current_amount) AS current
     FROM savings_goals g LEFT JOIN accounts a ON a.id = g.account_id
     WHERE g.id = ?`,
  ).bind(ev.goal_id).first<{ name: string; target_amount: number; current: number }>();
  const loc = await resolveLocale(env);
  const rates = await getRates(env);
  /**
   * ⚠️ **A trip's FOREIGN spending used to be dropped here** — `AND t.currency_code = 980`.
   *
   * The same hole was found and closed twice before, in `/events` and in `/events/:id`, with the
   * note that a trip is the worst possible place for it: abroad is exactly where another currency
   * appears, so the group whose total most needed the conversion was the one silently reporting
   * only its hryvnia half. The AI close-out was the third copy, and the last one nobody had
   * checked — it reads the same event and told the owner it came in under budget.
   *
   * Now every row is converted through the canon (`toBaseMinor`), like the list and the page.
   */
  const txs = await env.DB.prepare(
    `SELECT t.id, t.merchant, t.comment, t.amount, t.currency_code,
            COALESCE(${catNameSql(loc, "c.name")}, ${stLit(loc, "uncategorized")}) AS cat
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.event_id = ? ORDER BY t.amount ASC`,
  ).bind(eventId).all<TxLabelRow & { cat: string }>();
  const list = txs.results ?? [];
  // §BASE-CUR: the group's own figures and `monthly_burn_uah` two blocks down have to be in ONE
  // unit. Handing the model both un-reconciled is how a trip gets compared against a burn rate
  // 41× its own size — and the sentence it writes about that reads perfectly.
  const inBase = (minorUah: number) => Math.round(minorUah * uahToBase(rates));
  const conv = (t: TxLabelRow) => toBaseMinor(t.amount, t.currency_code, rates);
  const spent = list.filter((t) => t.amount < 0).reduce((s, t) => s - conv(t), 0);
  const income = list.filter((t) => t.amount > 0).reduce((s, t) => s + conv(t), 0);
  const byCat = new Map<string, number>();
  for (const t of list) if (t.amount < 0) byCat.set(t.cat, (byCat.get(t.cat) ?? 0) - conv(t));

  // Місячний burn + runway для масштабу.
  const now = Math.floor(Date.now() / 1000);
  const { mult: burnMult } = valueMode(rates, null);
  const burnRow = await env.DB.prepare(
    `SELECT ${spendSum(burnMult)} AS spent FROM transactions t ${STATS_JOINS} WHERE t.time >= ?`,
  ).bind(now - 90 * 86400).first<{ spent: number }>();
  const monthlyBurn = Math.round((burnRow?.spent ?? 0) / 3);
  const ownFunds = await ownFundsUAH(env);
  const runwayMonths = monthlyBurn > 0 ? Math.round((ownFunds / monthlyBurn) * 10) / 10 : null;

  return {
    ev, list,
    payload: {
      period_note: "total_spent_uah and categories.spent_uah are totals FOR THE WHOLE GROUP, not per month. monthly_burn_uah is the user's average monthly spending, given only for scale. Do not confuse the group total with a monthly one.",
      name: ev.name, kind: ev.kind, note: ev.note ?? "(no description)",
      total_spent_uah: Math.round(spent / 100),
      total_income_uah: Math.round(income / 100),
      tx_count: list.length,
      // §EVENT-GOAL: only present when linked, so the model never has to reason about a null.
      ...(ev.budget != null ? { budget_uah: Math.round(inBase(ev.budget) / 100) } : {}),
      ...(goal
        ? {
          goal: {
            name: goal.name,
            saved_uah: Math.round(inBase(goal.current) / 100),
            target_uah: Math.round(inBase(goal.target_amount) / 100),
            // Stated rather than left to arithmetic: this is the whole question the link exists
            // to answer, and a model asked to subtract two numbers will sometimes not.
            covered: spent <= inBase(goal.current),
            over_saved_uah: Math.max(0, Math.round((spent - inBase(goal.current)) / 100)),
          },
        }
        : {}),
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
  if (!g) return { reply: st(await resolveLocale(env), "errGroupNotFound") };
  const context = { group: g.payload, transactions: g.payload.transactions };
  const { text, usage } = await chatAdvice(env, context, messages);
  logUsage("group-chat", usage);
  return { reply: text };
}

// Інлайн-чат по КОНКРЕТНІЙ операції: людяна відповідь + опційне застосування зміни
// (категорія / прапорець переказу), коли з розмови стало однозначно ясно, що це.
export interface TxChatApplied { category_id?: number | null; category_name?: string | null; is_transfer?: boolean; understanding?: string }
