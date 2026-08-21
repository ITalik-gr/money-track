// §6.6 Weekly insight: aggregate the last 7 days (UAH), compare to the prior week,
// pass the numbers + user notes to Haiku, and cache the text in app_state.
import type { Env } from "../../env.ts";
// `generateInsight` lives HERE now (phase 5, L6): it used to sit in `ai.ts` while this file —
// its own feature file — already existed. ARCHITECTURE.md §3 D3 called that the anomaly: no
// rule decided which of the two files a feature went into, so features were smeared across both.
import { callHaikuJson } from "./json.ts";
import { replyLangDirective, moneyUnitDirective } from "./prompt.ts";
import { getTaskModel } from "./models.ts";
import type { AnthropicContentBlock } from "./ai.ts";
import type { AiFact } from "./generate.ts";
import type { AnthropicUsage } from "./cost.ts";
import { briefUsage, logUsage, type AiUsageBrief } from "./cost.ts";
import { groundFacts } from "./grounding.ts";

// Структурований інсайт для стилізованого рендеру (headline + факти + порада).
export interface StructuredInsight {
  headline: string;
  facts: AiFact[];
  note?: string | null;
}

// 6.6 Weekly insight → структурований JSON (щоб фронт стилізував суми/категорії/дельти).
export async function generateInsight(
  env: Env,
  payload: unknown,
): Promise<{ result: StructuredInsight; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "You are a financial assistant. From the aggregated figures for the period (period_label), write a short " +
        "insight. CONTEXT in the payload: user_profile (the real situation — respect it, do not advise \"by the " +
        "book\"), top_anomalies (the largest changes against the previous period; a negative delta_uah means " +
        "spending rose), by_importance (essential/discretionary/optional — where cutting is possible), " +
        "recurring_vs_oneoff (separate the usual monthly rhythm from one-off spikes — top_oneoff are the one-offs, " +
        "like taxes or a dentist; do NOT call them recurring and do NOT project them forward). Take user_notes into " +
        "account — if the user explained a one-off expense, do not call it recurring. Do not invent advice the " +
        "numbers do not support. " +
        "Answer with VALID JSON ONLY, no markdown: {headline (1 sentence — the main thing about the period), " +
        "facts:[{label, amount (UAH number or null), category (name or null), delta_pct (change against the previous " +
        "period, +/- number or null), tone ('pos'|'neg'|'neutral')}] (2-5 facts — where most went, notable changes, " +
        "anomalies, the split by importance), note (one short concrete piece of advice, or null)}. Amounts in " +
        "hryvnia." +
        (await replyLangDirective(env)) + (await moneyUnitDirective(env)),
    },
  ];
  return callHaikuJson<StructuredInsight>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 700, await getTaskModel(env, "insight"));
}
import { getState, setState } from "../finance/repo.ts";
import { getRates, resolveBaseCurrency } from "../finance/money.ts";
import { st, resolveLocale } from "../platform/i18n.ts";
import { catNameSql } from "../finance/categories-i18n.ts";
import { STATS_JOINS, EFF_AMOUNT, EFF_CAT_ID, EFF_CAT_NAME, EFF_IMPORTANCE, SPEND_WHERE, valueMode, spendSum, amountSum, recurringOneoffSplit } from "../finance/stats.ts";

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
  /**
   * §BASE-CUR — the currency the figures in `structured.facts` are in, stamped at generation.
   * A stored insight is re-read for days; the card must sign it with this, not with the currency
   * selected today. Absent = written before the setting existed, i.e. hryvnia.
   */
  cur?: number;
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
  const loc = await resolveLocale(env);
  const r = await env.DB.prepare(
    `SELECT ${catNameSql(loc, EFF_CAT_NAME)} AS name, ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time < ? AND ${SPEND_WHERE}
     GROUP BY ${EFF_CAT_ID} ORDER BY spent DESC LIMIT 8`,
  ).bind(from, to).all<{ name: string; spent: number; n: number }>();
  return (r.results ?? []).map((x) => ({ name: x.name ?? st(loc, "uncategorized"), spent: x.spent / 100, n: x.n }));
}

export async function buildAndStoreInsight(env: Env, periodDays?: number): Promise<StoredInsight> {
  const days = await resolvePeriodDays(env, periodDays);
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * DAY;
  const prevFrom = from - days * DAY;
  const rates = await getRates(env);
  const { mult } = valueMode(rates, null);

  const [thisWeek, prevWeek, merchants, notes, totalRow, events, importanceRows, split, profile] = await Promise.all([
    spendByCategory(env, from, now, mult),
    spendByCategory(env, prevFrom, from, mult),
    env.DB.prepare(
      `SELECT t.merchant AS merchant, ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n FROM transactions t ${STATS_JOINS}
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
      `SELECT ${EFF_IMPORTANCE} AS imp, ${amountSum(mult)} AS spent, COUNT(DISTINCT t.id) AS n FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time < ? AND ${SPEND_WHERE} GROUP BY imp`,
    ).bind(from, now).all<{ imp: string; spent: number; n: number }>(),
    recurringOneoffSplit(env, from, now, mult),
    getState(env.DB, "finance_profile"),
  ]);

  const totalUAH = (totalRow?.total ?? 0) / 100;
  const loc = await resolveLocale(env);
  const label = days === 7 ? st(loc, "insightWeek") : days === 30 ? st(loc, "insightMonth") : st(loc, "insightDays", { n: days });
  const base = { generated_at: now, period_from: from, period_to: now, period_days: days };

  let stored: StoredInsight;
  if (!totalUAH) {
    stored = { ...base, text: st(loc, "insightEmpty", { label }), empty: true };
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
      user_profile: profile || "(not specified)",
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
      // 🔒 The same deterministic guard the feed has had since the model quoted two different
      // figures for one thing in a single notification. These facts render as numbers on the
      // Advisor card and in the weekly Telegram digest, where nothing distinguishes an invented
      // one from a computed one — which is exactly the condition the rule was written for.
      const grounded = { ...result, facts: groundFacts(result.facts ?? [], payload) };
      stored = { ...base, text, structured: grounded, usage: briefUsage(usage) };
    } catch (e) {
      stored = { ...base, text: st(loc, "insightFailed", { error: String(e) }), empty: true };
    }
  }

  stored = { ...stored, cur: await resolveBaseCurrency(env) };
  await setState(env.DB, "insight", JSON.stringify(stored));
  return stored;
}

export async function getStoredInsight(env: Env): Promise<StoredInsight | null> {
  const raw = await getState(env.DB, "insight");
  return raw ? (JSON.parse(raw) as StoredInsight) : null;
}
