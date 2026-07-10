// AI-порадник (структурований): рахуємо runway із власних коштів і місячного burn,
// подаємо разом із профілем ситуації в Haiku → поради-картки. Кешуємо в app_state.
import type { Env } from "../env.ts";
import { type AdviceResult, type AiUsageBrief, type BudgetChatResult, type ChatMsg, type StructuredInsight, briefUsage, budgetChat, chatAdvice, evaluateGroup, generateAdvice, logUsage, proposeBudgetLimits, txChat } from "./ai.ts";
import { getState, setState } from "./repo.ts";
import { getRates, toUAHMinor } from "./finance.ts";
import { STATS_JOINS, EFF_CAT_ID, EFF_CAT_NAME, EFF_CAT_COLOR, EFF_IMPORTANCE, SPEND_WHERE, valueMode, spendSum, incomeSum, amountSum } from "./stats.ts";

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
  own_funds: number;      // копійки, UAH
  monthly_burn: number;   // копійки, UAH/міс
  runway_months: number | null;
  usage?: AiUsageBrief;
  generated_at: number;
}

async function ownFundsUAH(env: Env): Promise<number> {
  const accounts = await env.DB.prepare(
    "SELECT balance, credit_limit, currency_code FROM accounts WHERE is_active = 1",
  ).all<{ balance: number; credit_limit: number; currency_code: number }>();
  const rates = await getRates(env.DB);
  let total = 0;
  for (const a of accounts.results ?? []) {
    const own = (a.balance ?? 0) - (a.credit_limit ?? 0);
    total += toUAHMinor(own, a.currency_code, rates);
  }
  return Math.round(total);
}

export async function getProfile(env: Env): Promise<string> {
  return (await getState(env.DB, "finance_profile")) ?? "";
}
export async function setProfile(env: Env, text: string): Promise<void> {
  await setState(env.DB, "finance_profile", text);
}

export async function buildAdvice(env: Env): Promise<StoredAdvice> {
  const now = Math.floor(Date.now() / 1000);
  const from90 = now - 90 * 86400;
  const dNow = new Date(now * 1000);
  const monthStart = Math.floor(new Date(dNow.getFullYear(), dNow.getMonth(), 1).getTime() / 1000);
  const from6mo = Math.floor(new Date(dNow.getFullYear(), dNow.getMonth() - 5, 1).getTime() / 1000);

  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null); // канонічно, зведено в ₴
  const [ownFunds, burnRow, cats, merchants, events, importance, trend, budgetRows, monthByCat, subsAgg] = await Promise.all([
    ownFundsUAH(env),
    env.DB.prepare(
      `SELECT ${spendSum(mult)} AS spent FROM transactions t ${STATS_JOINS} WHERE t.time >= ?`,
    ).bind(from90).first<{ spent: number }>(),
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
  ]);

  const monthlyBurn = Math.round((burnRow?.spent ?? 0) / 3); // 90 днів → місяць
  const runwayMonths = monthlyBurn > 0 ? Math.round((ownFunds / monthlyBurn) * 10) / 10 : null;
  const profile = await getProfile(env);

  // §2: бюджети — ліміт vs факт за поточний місяць.
  const monthSpent = new Map((monthByCat.results ?? []).map((r) => [r.id, Math.abs(r.spent)]));
  const budgets = (budgetRows.results ?? []).map((b) => {
    const spent = monthSpent.get(b.id) ?? 0;
    return { category: b.name, limit_uah: Math.round(b.lim / 100), spent_uah: Math.round(spent / 100), used_pct: b.lim > 0 ? Math.round((spent / b.lim) * 100) : null };
  });
  const subsMonthly = Math.round((subsAgg?.planned ?? 0) / 100);
  // §2/§5: найбільші операції з id — щоб AI цитував конкретику токеном [tx:ID].
  const citable = await notableTransactions(env, 90, 12);

  const payload = {
    period_note: "top_categories/top_merchants/by_event — суми за ОСТАННІ 90 ДНІВ (3 місяці); avg_month_uah — усереднене на місяць. monthly_burn_uah — середні витрати/міс. НЕ плутай 90д із місячною; спирайся на avg_month_uah. by_importance: essential=обов'язкові (не ріж), discretionary=бажані, optional=необов'язкові (найбезпечніше скорочувати). monthly_trend: spend/income по місяцях (6 міс) — дивись динаміку/сезонність, а не лише середнє. budgets: ліміт vs факт цього місяця (used_pct>100 = перевитрата — підсвіти). subscriptions_monthly_uah: фіксовані підписки/міс (майже незмінні). Цитуй конкретику: категорії, підписки, бюджети.",
    period_days: 90,
    situation: profile || "(не вказано)",
    own_funds_uah: Math.round(ownFunds / 100),
    monthly_burn_uah: Math.round(monthlyBurn / 100),
    runway_months: runwayMonths,
    subscriptions_monthly_uah: subsMonthly,
    subscriptions_count: subsAgg?.n ?? 0,
    top_categories: (cats.results ?? []).map((c) => ({ id: c.id, name: c.name, spent_90d_uah: Math.round(c.spent / 100), avg_month_uah: Math.round(c.spent / 3 / 100) })),
    top_merchants: (merchants.results ?? []).map((m) => ({ merchant: m.merchant, spent_90d_uah: Math.round(m.spent / 100), avg_month_uah: Math.round(m.spent / 3 / 100) })),
    by_event: (events.results ?? []).map((e) => ({ event: e.name, spent_90d_uah: Math.round(e.spent / 100), avg_month_uah: Math.round(e.spent / 3 / 100) })),
    by_importance: (importance.results ?? []).map((x) => ({ level: x.importance, spent_90d_uah: Math.round(x.spent / 100) })),
    monthly_trend: (trend.results ?? []).map((t) => ({ month: t.m, spend_uah: Math.round(t.spend / 100), income_uah: Math.round(t.income / 100) })),
    budgets,
    citable_operations: citable, // [{id, label}] — для цитат [tx:ID] у тексті
  };

  const { result, usage } = await generateAdvice(env, payload);
  logUsage("advice", usage);
  const stored: StoredAdvice = {
    ...result,
    own_funds: ownFunds,
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
    });
    await setState(env.DB, "advisor_history", JSON.stringify(hist.slice(0, 12)));
  } catch { /* історія не критична */ }

  return stored;
}

export interface AdviceHistoryItem {
  generated_at: number; summary: string; runway_months: number | null; monthly_burn: number; own_funds: number;
}
export async function getAdviceHistory(env: Env): Promise<AdviceHistoryItem[]> {
  const raw = await getState(env.DB, "advisor_history");
  return raw ? (JSON.parse(raw) as AdviceHistoryItem[]) : [];
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

  const totalSpent90 = cats.reduce((s, c) => s + c.spent, 0);
  const monthlyBurn = Math.round(totalSpent90 / 3);
  const runwayMonths = monthlyBurn > 0 ? Math.round((ownFunds / monthlyBurn) * 10) / 10 : null;

  const payload = {
    situation: (await getProfile(env)) || "(не вказано)",
    own_funds_uah: Math.round(ownFunds / 100),
    monthly_burn_uah: Math.round(monthlyBurn / 100),
    runway_months: runwayMonths,
    categories: cats.map((c) => ({
      id: c.category_id,
      name: c.name,
      avg_month_uah: Math.round(c.spent / 3 / 100),
      current_limit_uah: Math.round((currentLimit.get(c.category_id) ?? 0) / 100),
    })),
  };

  const { result, usage } = await proposeBudgetLimits(env, payload);
  logUsage("budget-plan", usage);
  const byId = new Map(result.proposals.map((p) => [p.category_id, p]));

  const rows: BudgetProposalRow[] = cats.map((c) => {
    const p = byId.get(c.category_id);
    const avgMonth = Math.round(c.spent / 3);
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
  const monthlyBurn = Math.round(cats.reduce((s, c) => s + c.spent, 0) / 3);

  const ctx = {
    situation: (await getProfile(env)) || "(не вказано)",
    own_funds_uah: Math.round(ownFunds / 100),
    monthly_burn_uah: Math.round(monthlyBurn / 100),
    categories: cats.map((c) => ({
      id: c.id, name: c.name, importance: c.importance,
      avg_month_uah: Math.round(c.spent / 3 / 100),
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
  const now = Math.floor(Date.now() / 1000);
  const from90 = now - 90 * 86400;

  // Прикріплені юзером транзакції — беруть пріоритет у контексті.
  let attached: { id: string; label: string }[] = [];
  if (attachedTxIds.length) {
    const ph = attachedTxIds.slice(0, 10).map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id, merchant, comment, amount, currency_code FROM transactions WHERE id IN (${ph})`,
    ).bind(...attachedTxIds.slice(0, 10)).all<TxLabelRow>();
    attached = (rows.results ?? []).map(txLabel);
  }

  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null);
  const [ownFunds, burnRow, cats, events] = await Promise.all([
    ownFundsUAH(env),
    env.DB.prepare(
      `SELECT ${spendSum(mult)} AS spent FROM transactions t ${STATS_JOINS} WHERE t.time >= ?`,
    ).bind(from90).first<{ spent: number }>(),
    env.DB.prepare(
      `SELECT ${EFF_CAT_NAME} AS name, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND ${SPEND_WHERE}
       GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC LIMIT 8`,
    ).bind(from90).all<{ name: string; spent: number }>(),
    env.DB.prepare(
      `SELECT e.name AS name, ${amountSum(mult)} AS spent FROM transactions t JOIN event_groups e ON e.id = t.event_id
       WHERE t.time >= ? AND t.amount < 0 AND t.is_transfer = 0
       GROUP BY t.event_id ORDER BY spent DESC LIMIT 6`,
    ).bind(from90).all<{ name: string; spent: number }>(),
  ]);

  const monthlyBurn = Math.round((burnRow?.spent ?? 0) / 3);
  const runwayMonths = monthlyBurn > 0 ? Math.round((ownFunds / monthlyBurn) * 10) / 10 : null;
  // Транзакції для контексту: прикріплені + помітні (дедуп за id).
  const notable = await notableTransactions(env);
  const seen = new Set(attached.map((t) => t.id));
  const transactions = [...attached, ...notable.filter((t) => !seen.has(t.id))].slice(0, 20);
  const context = {
    // ВАЖЛИВО про періоди: monthly_burn_uah — це вже СЕРЕДНЄ ЗА МІСЯЦЬ. А суми по категоріях/
    // мерчантах/подіях подаємо і за весь період (90 днів), і усереднені на місяць — щоб AI
    // не плутав накопичене за 3 міс із місячним (це була системна помилка).
    period_note: "top_categories/by_event — суми за ОСТАННІ 90 ДНІВ (3 місяці); avg_month_uah — те саме, усереднене на місяць. monthly_burn_uah — середні витрати на місяць. НЕ плутай суму за 90 днів із місячною.",
    period_days: 90,
    situation: (await getProfile(env)) || "(не вказано)",
    own_funds_uah: Math.round(ownFunds / 100),
    monthly_burn_uah: Math.round(monthlyBurn / 100),
    runway_months: runwayMonths,
    top_categories: (cats.results ?? []).map((c) => ({ name: c.name, spent_90d_uah: Math.round(c.spent / 100), avg_month_uah: Math.round(c.spent / 3 / 100) })),
    by_event: (events.results ?? []).map((e) => ({ event: e.name, spent_90d_uah: Math.round(e.spent / 100), avg_month_uah: Math.round(e.spent / 3 / 100) })),
    attached_transactions: attached,
    transactions,
  };

  const { text, usage } = await chatAdvice(env, context, messages);
  logUsage("chat", usage);
  return { reply: text };
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
export interface TxChatApplied { category_id?: number | null; category_name?: string | null; is_transfer?: boolean }
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

  return { reply: result.reply, applied: Object.keys(applied).length ? applied : undefined };
}
