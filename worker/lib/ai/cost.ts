// L2 — what a call COSTS, and the running total.
//
// Provider-specific (these are Anthropic's prices and Anthropic's usage shape), and deliberately
// separate from L1 transport: the transport decides how to ask, this decides what the answer was
// worth. `recordUsage` is called from inside the three functions that actually POST, so it cannot
// be forgotten by a future call site — the same reasoning as `demoClamp`.
//
// ⚠️ Ceilings are in DOLLARS, not calls (`DEMO_GLOBAL_DAILY_USD_CAP`): "300 calls" is anywhere
// from $0.30 to $4 depending on which model answered.
import type { Env } from "../../env.ts";
import { getState, setState } from "../finance/repo.ts";
import { demoRecordSpend } from "../platform/demo.ts";
import { MODEL_FAST, MODEL_SMART, MODEL_OPUS } from "./models.ts";
import { localYm, localYmd } from "../finance/time.ts";


export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  // Розбивка write-кешу за TTL (API повертає, коли є кеш-write). 5хв=1.25×, 1год=2×.
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

// Спостережуваність вартості AI (§технічні нотатки): компактний usage + лог у консоль.
export interface AiUsageBrief { in: number; out: number; cache_read: number }
export function briefUsage(u: AnthropicUsage): AiUsageBrief {
  return { in: u.input_tokens, out: u.output_tokens, cache_read: u.cache_read_input_tokens ?? 0 };
}
export function logUsage(tag: string, u: AnthropicUsage): void {
  console.log(
    `[ai:${tag}] in=${u.input_tokens} out=${u.output_tokens} ` +
    `cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0}`,
  );
}

// §Хвіст (варіант C): глобальний лічильник витрат AI. logUsage лише пише в консоль;
// тут ми АКУМУЛЮЄМО usage у app_state, щоб показати «$ за сьогодні/місяць» у Налаштуваннях.
// Записується централізовано в callHaiku/callHaikuMessages, тож ловить УСІ виклики (вкл. ретраї).

// Ціни за 1M токенів (USD). Стікер; вступну ціну Sonnet 5 див. priceFor.
// cache read ≈ 0.1× input; cache write — 1.25× (5хв TTL) / 2× (1год TTL) — див. callCostUsd.
const PRICES: Record<string, { in: number; out: number }> = {
  [MODEL_FAST]: { in: 1.0, out: 5.0 },   // Haiku 4.5
  [MODEL_SMART]: { in: 3.0, out: 15.0 }, // Sonnet 5 (стікер; до 31.08.2026 діє вступна)
  [MODEL_OPUS]: { in: 5.0, out: 25.0 },  // Opus 4.8
};

// Sonnet 5: ВСТУПНА ціна $2/$10 за MTok діє ДО 2026-08-31 включно (тобто до 01.09.2026 UTC),
// після — стікер $3/$15. Тож ціна Sonnet — date-aware (§A2).
const SONNET_INTRO_END = Date.UTC(2026, 8, 1) / 1000; // 1 вересня 2026, 00:00 UTC
const SONNET_INTRO: { in: number; out: number } = { in: 2.0, out: 10.0 };

function priceFor(model: string, nowSec: number): { in: number; out: number } {
  if (model === MODEL_SMART && nowSec < SONNET_INTRO_END) return SONNET_INTRO;
  return PRICES[model] ?? PRICES[MODEL_FAST];
}

export function callCostUsd(model: string, u: AnthropicUsage, nowSec: number = Date.now() / 1000): number {
  const p = priceFor(model, nowSec);
  const cacheRead = u.cache_read_input_tokens ?? 0;
  // Cache write множник за TTL: 5хв=1.25×, 1год=2×. Беремо розбивку, коли API її дав;
  // інакше — агрегат за нашим фактичним TTL (усі write-и через buildSystemPrefix — 1год → 2×).
  const cc = u.cache_creation;
  const write5m = cc?.ephemeral_5m_input_tokens ?? 0;
  const write1h = cc?.ephemeral_1h_input_tokens ?? 0;
  const cacheWriteCost =
    cc && (write5m || write1h)
      ? write5m * p.in * 1.25 + write1h * p.in * 2.0
      : (u.cache_creation_input_tokens ?? 0) * p.in * 2.0;
  return (
    (u.input_tokens * p.in +
      u.output_tokens * p.out +
      cacheRead * p.in * 0.1 +
      cacheWriteCost) /
    1_000_000
  );
}

interface UsageBucket { in: number; out: number; cache_read: number; cache_write: number; cost_usd: number; calls: number }
export interface AiUsageStats {
  today: UsageBucket & { key: string };
  month: UsageBucket & { key: string };
  total: UsageBucket;
  updated_at: number;
}
interface UsageStore { days: Record<string, UsageBucket>; months: Record<string, UsageBucket>; total: UsageBucket; updated_at: number }

function emptyBucket(): UsageBucket { return { in: 0, out: 0, cache_read: 0, cache_write: 0, cost_usd: 0, calls: 0 }; }
function addTo(b: UsageBucket, u: AnthropicUsage, cost: number): void {
  b.in += u.input_tokens;
  b.out += u.output_tokens;
  b.cache_read += u.cache_read_input_tokens ?? 0;
  b.cache_write += u.cache_creation_input_tokens ?? 0;
  b.cost_usd += cost;
  b.calls += 1;
}

// §APP_TZ day/month keys (2026-08-21). Особистий апп, низька конкурентність — read-modify-write ок.
//
// These were UTC while `quota.ts` (the receipt cap) already keyed on the Kyiv day, so the app held
// two "today"s three hours apart: the «💸 Витрати на AI · сьогодні» card went on counting last
// night's calls until 03:00, and on the 1st the monthly figure did the same. Both are shown to the
// owner beside each other, and the rule CLAUDE.md states for the quota — «Ключ доби — київський,
// інакше квота оновлювалась би о 03:00» — is the same rule.
function dayKey(now: number): string { return localYmd(now); }
function monthKey(now: number): string { return localYm(now); }

export async function recordUsage(env: Env, model: string, u: AnthropicUsage): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const cost = callCostUsd(model, u, now);
    // Demo sandboxes also book the cost against the shared budget (lib/demo.ts). Done here rather
    // than at the call sites for the same reason as `demoClamp`: this is the one place every
    // Anthropic response passes through, so it cannot be forgotten by a future feature.
    await demoRecordSpend(env, cost);
    const raw = await getState(env.DB, "ai_usage");
    const store: UsageStore = raw
      ? (JSON.parse(raw) as UsageStore)
      : { days: {}, months: {}, total: emptyBucket(), updated_at: now };
    const dk = dayKey(now);
    const mk = monthKey(now);
    (store.days[dk] ??= emptyBucket());
    (store.months[mk] ??= emptyBucket());
    addTo(store.days[dk], u, cost);
    addTo(store.months[mk], u, cost);
    addTo(store.total, u, cost);
    store.updated_at = now;
    // Обрізаємо історію, щоб рядок не ріс безмежно: останні 60 днів / 24 місяці.
    store.days = trimNewest(store.days, 60);
    store.months = trimNewest(store.months, 24);
    await setState(env.DB, "ai_usage", JSON.stringify(store));
  } catch {
    /* лічильник — не критичний; ніколи не валимо основний виклик */
  }
}

function trimNewest(map: Record<string, UsageBucket>, keep: number): Record<string, UsageBucket> {
  const keys = Object.keys(map).sort();
  if (keys.length <= keep) return map;
  const drop = keys.slice(0, keys.length - keep);
  for (const k of drop) delete map[k];
  return map;
}

// Читання для API (Налаштування): сьогодні + цей місяць + за весь час.
export async function readUsageStats(env: Env): Promise<AiUsageStats> {
  const now = Math.floor(Date.now() / 1000);
  const raw = await getState(env.DB, "ai_usage");
  const store: UsageStore = raw
    ? (JSON.parse(raw) as UsageStore)
    : { days: {}, months: {}, total: emptyBucket(), updated_at: now };
  const dk = dayKey(now);
  const mk = monthKey(now);
  return {
    today: { key: dk, ...(store.days[dk] ?? emptyBucket()) },
    month: { key: mk, ...(store.months[mk] ?? emptyBucket()) },
    total: store.total ?? emptyBucket(),
    updated_at: store.updated_at ?? now,
  };
}
