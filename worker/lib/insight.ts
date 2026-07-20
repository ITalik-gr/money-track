// §6.6 Weekly insight: aggregate the last 7 days (UAH), compare to the prior week,
// pass the numbers + user notes to Haiku, and cache the text in app_state.
import type { Env } from "../env.ts";
import { generateInsight, briefUsage, logUsage, type StructuredInsight, type AiUsageBrief } from "./ai.ts";
import { getState, setState } from "./repo.ts";
import { getRates } from "./finance.ts";
import { STATS_JOINS, EFF_AMOUNT, EFF_CAT_ID, EFF_CAT_NAME, EFF_IMPORTANCE, SPEND_WHERE, valueMode, spendSum, amountSum, recurringOneoffSplit } from "./stats.ts";

const DAY = 86400;
const PERIOD_KEY = "insight_period_days";

export interface StoredInsight {
  text: string;                     // fallback (headline + note) для сумісності
  structured?: StructuredInsight;   // для стилізованого рендеру
  usage?: AiUsageBrief;
  generated_at: number;
  period_from: number;
  period_to: number;
  period_days: number;
  empty?: boolean;
}

// Скільки днів покриває інсайт. Налаштовується користувачем, використовується кроном.
async function resolvePeriodDays(env: Env, override?: number): Promise<number> {
  if (override && override > 0) {
    await setState(env.DB, PERIOD_KEY, String(override));
    return override;
  }
  const saved = Number(await getState(env.DB, PERIOD_KEY));
  return saved > 0 ? saved : 7;
}

// Канонічна розбивка по ефективній категорії, зведено в ₴ (як Статистика/репорти).
async function spendByCategory(env: Env, from: number, to: number, mult: string) {
  const r = await env.DB.prepare(
    `SELECT ${EFF_CAT_NAME} AS name, ${amountSum(mult)} AS spent, COUNT(*) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time < ? AND ${SPEND_WHERE}
     GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC LIMIT 8`,
  ).bind(from, to).all<{ name: string; spent: number; n: number }>();
  return (r.results ?? []).map((x) => ({ name: x.name ?? "без категорії", spent: x.spent / 100, n: x.n }));
}

export async function buildAndStoreInsight(env: Env, periodDays?: number): Promise<StoredInsight> {
  const days = await resolvePeriodDays(env, periodDays);
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * DAY;
  const prevFrom = from - days * DAY;
  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null);

  const [thisWeek, prevWeek, merchants, notes, totalRow, events, importanceRows, split, profile] = await Promise.all([
    spendByCategory(env, from, now, mult),
    spendByCategory(env, prevFrom, from, mult),
    env.DB.prepare(
      `SELECT t.merchant AS merchant, ${amountSum(mult)} AS spent, COUNT(*) AS n FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time < ? AND ${SPEND_WHERE} AND t.merchant IS NOT NULL
       GROUP BY t.merchant ORDER BY spent DESC LIMIT 6`,
    ).bind(from, now).all<{ merchant: string; spent: number; n: number }>(),
    env.DB.prepare(
      `SELECT merchant, user_note FROM transactions
       WHERE time >= ? AND time < ? AND user_note IS NOT NULL AND user_note <> '' LIMIT 20`,
    ).bind(from, now).all<{ merchant: string | null; user_note: string }>(),
    env.DB.prepare(
      `SELECT ${spendSum(mult)} AS total FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time < ?`,
    ).bind(from, now).first<{ total: number | null }>(),
    env.DB.prepare(
      `SELECT e.name AS name, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS} JOIN event_groups e ON e.id = t.event_id
       WHERE t.time >= ? AND t.time < ? AND ${EFF_AMOUNT} < 0 AND t.is_transfer = 0
       GROUP BY t.event_id ORDER BY spent DESC LIMIT 6`,
    ).bind(from, now).all<{ name: string; spent: number }>(),
    env.DB.prepare(
      `SELECT ${EFF_IMPORTANCE} AS imp, ${amountSum(mult)} AS spent, COUNT(*) AS n FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time < ? AND ${SPEND_WHERE} GROUP BY imp`,
    ).bind(from, now).all<{ imp: string; spent: number; n: number }>(),
    recurringOneoffSplit(env, from, now, mult),
    getState(env.DB, "finance_profile"),
  ]);

  const totalUAH = (totalRow?.total ?? 0) / 100;
  const label = days === 7 ? "тиждень" : days === 30 ? "місяць" : `${days} дн`;
  const base = { generated_at: now, period_from: from, period_to: now, period_days: days };

  let stored: StoredInsight;
  if (!totalUAH) {
    stored = { ...base, text: `За обраний період (${label}) витрат не було.`, empty: true };
  } else {
    // Топ-аномалії: категорії з найбільшою зміною суми проти минулого періоду (детерміновано,
    // без прогнозу — просто «що змінилось найпомітніше»). spent тут від'ємний (витрата).
    const prevMap = new Map(prevWeek.map((c) => [c.name, c.spent]));
    const anomalies = thisWeek
      .map((c) => ({ category: c.name, delta_uah: Math.round(c.spent - (prevMap.get(c.name) ?? 0)) }))
      .filter((c) => Math.abs(c.delta_uah) >= 200)
      .sort((a, b) => Math.abs(b.delta_uah) - Math.abs(a.delta_uah))
      .slice(0, 4);
    // §6 вагомість: скільки пішло на essential/discretionary/optional за період.
    const importance = (importanceRows.results ?? []).map((r) => ({ level: r.imp, spent: Math.round(r.spent / 100), n: r.n }));
    const payload = {
      period_label: label,
      total_uah_this_period: Math.round(totalUAH),
      user_profile: profile || "(не вказано)",
      by_category_this_period: thisWeek,
      by_category_prev_period: prevWeek,
      top_anomalies: anomalies,
      by_importance: importance,
      recurring_vs_oneoff: {
        recurring_uah: Math.round(split.recurring.spent / 100),
        oneoff_uah: Math.round(split.oneoff.spent / 100),
        top_oneoff: split.oneoff_items.slice(0, 5).map((o) => ({ merchant: o.merchant, category: o.category, uah: Math.round(o.amount / 100) })),
      },
      top_merchants: (merchants.results ?? []).map((m) => ({ merchant: m.merchant, spent: m.spent / 100, n: m.n })),
      by_event: (events.results ?? []).map((e) => ({ event: e.name, spent: Math.round(e.spent / 100) })),
      user_notes: (notes.results ?? []).map((n) => ({ merchant: n.merchant, note: n.user_note })),
    };
    try {
      const { result, usage } = await generateInsight(env, payload);
      const text = [result.headline, result.note].filter(Boolean).join(" ");
      logUsage("insight", usage);
      stored = { ...base, text, structured: result, usage: briefUsage(usage) };
    } catch (e) {
      stored = { ...base, text: `Не вдалося згенерувати інсайт: ${String(e)}`, empty: true };
    }
  }

  await setState(env.DB, "insight", JSON.stringify(stored));
  return stored;
}

export async function getStoredInsight(env: Env): Promise<StoredInsight | null> {
  const raw = await getState(env.DB, "insight");
  return raw ? (JSON.parse(raw) as StoredInsight) : null;
}
