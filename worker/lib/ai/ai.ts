// Claude Haiku 4.5 layer (§6). One key, one model. Stable prompt prefix (system +
// full category list + few-shot) is marked with cache_control so we don't pay for it
// on every call. NOTE (§6.7): Haiku's min cacheable prefix is 4096 tokens — the
// category taxonomy + examples must stay large enough or the cache silently no-ops.
import type { Env } from "../../env.ts";
import { getState, setState } from "../finance/repo.ts";
import { buildKnowledgeCorpus } from "./knowledge/index.ts";
import { demoAiGate, demoRecordSpend, isDemoEnv } from "../platform/demo.ts";

// Гібрид (рішення користувача 2026-07-06): масові/фонові задачі — дешевий Haiku;
// розумні user-facing (чат по операції, поради, розуміння підписок, рев'ю) — Sonnet 5.
export const MODEL_FAST = "claude-haiku-4-5";
export const MODEL_SMART = "claude-sonnet-5";
export const MODEL_OPUS = "claude-opus-4-8";
const API = "https://api.anthropic.com/v1/messages";

// Моделі окремо НА ЗАДАЧУ (рішення 2026-07-11). Кожна user-facing задача має свій ключ
// app_state.ai_model_<task> зі значенням-токеном (haiku|sonnet|opus). Дефолти нижче:
// репорти — Opus (найглибший розбір), порадник/чат/бюджет — Sonnet, AI-огляд — Haiku (масово/дешево).
// Enrich/OCR/categorize НЕ конфігуруються: авто/масово — Haiku; ВИНЯТОК — enrich, коли користувач
// САМ описав операцію нотаткою (user_note) → Sonnet (поважає пояснення, не плутає зарплату з подарунком).
export type AiTask = "report" | "advisor" | "insight" | "chat" | "budget" | "group" | "notify";
export const AI_TASK_DEFAULTS: Record<AiTask, string> = {
  report: MODEL_OPUS,
  advisor: MODEL_SMART,
  insight: MODEL_FAST,
  chat: MODEL_SMART,
  budget: MODEL_SMART,
  group: MODEL_SMART,
  // Спостереження для стрічки сповіщень: щодня, коротко, з готових цифр → Haiku.
  notify: MODEL_FAST,
};
export const MODEL_BY_TOKEN: Record<string, string> = { haiku: MODEL_FAST, sonnet: MODEL_SMART, opus: MODEL_OPUS };
export const TOKEN_BY_MODEL: Record<string, string> = { [MODEL_FAST]: "haiku", [MODEL_SMART]: "sonnet", [MODEL_OPUS]: "opus" };

// Модель для задачі: збережений токен (якщо валідний) інакше дефолт задачі.
export async function getTaskModel(env: Env, task: AiTask): Promise<string> {
  // Demo sandboxes are forced onto the cheapest model regardless of the saved `ai_model_*`
  // preference (P4.3) — a visitor must not be able to point our billing at Opus.
  if (isDemoEnv(env)) return MODEL_FAST;
  const saved = await getState(env.DB, `ai_model_${task}`);
  if (saved && MODEL_BY_TOKEN[saved]) return MODEL_BY_TOKEN[saved];
  return AI_TASK_DEFAULTS[task];
}

// Demo request clamp — ONE choke point, applied inside the three functions that actually POST
// to Anthropic (2026-07-26).
//
// WHY NOT AT THE CALL SITES: `getTaskModel` already forced Haiku for demo, and three call sites
// still reached Sonnet because they pass a model constant directly — enrich with a user note
// (`ai.ts` enrichTransaction), transfer-category review (`enrich.ts`), and `/planned/ai-detect`.
// All three are reachable by a demo visitor (only credentials/setup/import/admin are blocked for
// writes). Per the project rule "перевірка > інструкція": a guard that every future call site has
// to remember is not a guard. Clamping where the fetch happens cannot be forgotten.
//
// Three things are clamped: the model (Haiku only — a visitor must never point our billing at
// Opus/Sonnet), the output ceiling, and server-side tools (`web_search` is billed per search on
// top of tokens, and a sandbox has no business browsing on our key).
const DEMO_MAX_OUTPUT_TOKENS = 900;
function demoClamp(
  env: Env,
  req: { model: string; maxTokens: number; tools?: unknown[] },
): { model: string; maxTokens: number; tools?: unknown[] } {
  if (!isDemoEnv(env)) return req;
  // Client tools are `{name, description, input_schema}`; server tools carry a `type`
  // (`web_search_*`, `web_fetch_*`). Dropping by shape keeps this correct for tools added later.
  const tools = req.tools?.filter((t) => typeof (t as { type?: unknown })?.type !== "string");
  return { model: MODEL_FAST, maxTokens: Math.min(req.maxTokens, DEMO_MAX_OUTPUT_TOKENS), tools };
}

// Sonnet/Opus вмикають adaptive-thinking, коли поле thinking відсутнє — для наших легких
// JSON/чат-викликів це зайва латентність і вартість. Явно вимикаємо. Haiku не чіпаємо.
function thinkingOff(model: string): Record<string, unknown> {
  return model !== MODEL_FAST ? { thinking: { type: "disabled" } } : {};
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
}

// §A3 (AI 4.0): серверний web_search. Обмежуємо офіційними/фінансовими джерелами, щоб не
// тягнути шум (курс НБУ, тарифи, податки, ціни). Приватність: пошук іде тим самим каналом
// Anthropic, що й знімок фінансів — не третій стороні.
const WEB_SEARCH_DOMAINS = ["bank.gov.ua", "minfin.com.ua", "index.minfin.com.ua", "tax.gov.ua"];
// Sonnet/Opus → динамічна фільтрація (_20260209); Haiku 4.5 — лише базовий (_20250305).
export function webSearchTool(model: string, maxUses = 4): Record<string, unknown> {
  const type = model === MODEL_FAST ? "web_search_20250305" : "web_search_20260209";
  return { type, name: "web_search", max_uses: maxUses, allowed_domains: WEB_SEARCH_DOMAINS };
}

interface AnthropicUsage {
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

// UTC-дати (день/місяць). Особистий апп, низька конкурентність — read-modify-write ок.
function dayKey(now: number): string { return new Date(now * 1000).toISOString().slice(0, 10); }
function monthKey(now: number): string { return new Date(now * 1000).toISOString().slice(0, 7); }

async function recordUsage(env: Env, model: string, u: AnthropicUsage): Promise<void> {
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

async function callHaiku(
  env: Env,
  system: AnthropicContentBlock[],
  userContent: unknown[],
  maxTokensIn = 1024,
  modelIn: string = MODEL_FAST,
): Promise<{ text: string; usage: AnthropicUsage; stop: string | null; capped: boolean }> {
  await demoAiGate(env); // P4.3: cap/deny Anthropic spend for demo sandboxes (no-op for real users)
  const { model, maxTokens } = demoClamp(env, { model: modelIn, maxTokens: maxTokensIn });
  // Did the ENVIRONMENT shrink the budget (the demo's 900-token ceiling), rather than the caller
  // asking for little? A caller that retries on truncation must NOT retry in that case: a bigger
  // ask is clamped to the same ceiling, so it buys an identical answer and a second charge
  // against the demo's shared AI budget. Caught on a live demo run — one report burned three
  // calls, each doomed to the same 900 tokens.
  const capped = maxTokens < maxTokensIn;
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...thinkingOff(model),
      system,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
    usage: AnthropicUsage;
    stop_reason?: string | null;
  };
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  await recordUsage(env, model, data.usage); // §Хвіст C: акумулюємо вартість усіх викликів
  return { text, usage: data.usage, stop: data.stop_reason ?? null, capped };
}

// Витягнути перший збалансований {...} або [...] блок, толеруючи прозу до/після
// та рядки з екранованими лапками. Haiku інколи додає текст або обриває огорожу.
// Багатоходовий діалог (чат-порадник): приймає повну історію повідомлень.
export interface ChatMsg { role: "user" | "assistant"; content: string }

async function callHaikuMessages(
  env: Env,
  system: AnthropicContentBlock[],
  messages: ChatMsg[],
  maxTokensIn = 700,
  modelIn: string = MODEL_FAST,
): Promise<{ text: string; usage: AnthropicUsage; stop: string | null; capped: boolean }> {
  await demoAiGate(env); // P4.3: cap/deny Anthropic spend for demo sandboxes (no-op for real users)
  const { model, maxTokens } = demoClamp(env, { model: modelIn, maxTokens: maxTokensIn });
  const capped = maxTokens < maxTokensIn; // see `callHaiku` — a clamped budget must not be retried
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, ...thinkingOff(model), system, messages }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[]; usage: AnthropicUsage; stop_reason?: string | null };
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  await recordUsage(env, model, data.usage); // §Хвіст C: акумулюємо вартість усіх викликів
  return { text, usage: data.usage, stop: data.stop_reason ?? null, capped };
}

// §AGENT (2026-07-14): агентний tool-use для чату. Модель може викликати інструменти
// (запити до повної бази операцій), коли фіксованого контексту не вистачає — напр. «скільки
// я витратив на таксі влітку торік». Домаінна логіка інструментів (SQL) живе в advisor.ts;
// тут — лише транспорт: цикл виклик→tool_use→tool_result→повтор до текстової відповіді.
export interface ChatTool { name: string; description: string; input_schema: Record<string, unknown> }
export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<unknown>;
interface RawMsg { role: "user" | "assistant"; content: unknown }
interface RawBlock { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }

async function callMessagesRaw(
  env: Env,
  system: AnthropicContentBlock[],
  messages: RawMsg[],
  maxTokensIn: number,
  modelIn: string,
  toolsIn?: unknown[], // client-side ChatTool[] та/або серверні блоки (web_search)
): Promise<{ content: RawBlock[]; usage: AnthropicUsage; stop: string | null }> {
  await demoAiGate(env); // P4.3: cap/deny Anthropic spend for demo sandboxes (no-op for real users)
  const { model, maxTokens, tools } = demoClamp(env, { model: modelIn, maxTokens: maxTokensIn, tools: toolsIn });
  const res = await fetch(API, {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, ...thinkingOff(model), system, messages, ...(tools?.length ? { tools } : {}) }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: RawBlock[]; usage: AnthropicUsage; stop_reason?: string | null };
  await recordUsage(env, model, data.usage); // §Хвіст C: кожен виклик (вкл. tool-turns) у лічильник
  return { content: data.content ?? [], usage: data.usage, stop: data.stop_reason ?? null };
}

// Веде діалог з інструментами до фінальної текстової відповіді (кеп ходів — межа вартості).
async function runToolConversation(
  env: Env,
  system: AnthropicContentBlock[],
  initial: ChatMsg[],
  tools: ChatTool[],
  executor: ToolExecutor,
  maxTokens: number,
  model: string,
  maxTurns = 6,
  serverTools: unknown[] = [], // §A3: серверні tools (web_search) — виконуються на боці Anthropic
): Promise<{ text: string; usage: AnthropicUsage }> {
  const reqTools = [...tools, ...serverTools];
  const messages: RawMsg[] = initial.map((m) => ({ role: m.role, content: m.content }));
  const total: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const add = (u: AnthropicUsage) => {
    total.input_tokens += u.input_tokens; total.output_tokens += u.output_tokens;
    total.cache_read_input_tokens = (total.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    total.cache_creation_input_tokens = (total.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  };
  const textOf = (content: RawBlock[]) => content.filter((b) => b.type === "text").map((b) => b.text).join("");

  for (let turn = 0; turn < maxTurns; turn++) {
    const { content, usage, stop } = await callMessagesRaw(env, system, messages, maxTokens, model, reqTools);
    add(usage);
    // §A3: серверний цикл (web_search) міг паузитись — дослати ту саму розмову, щоб він завершив.
    if (stop === "pause_turn") { messages.push({ role: "assistant", content }); continue; }
    if (stop === "tool_use") {
      const uses = content.filter((b) => b.type === "tool_use");
      messages.push({ role: "assistant", content });
      const results = [];
      for (const u of uses) {
        let out: unknown;
        try { out = await executor(u.name ?? "", u.input ?? {}); }
        catch (e) { out = { error: String(e instanceof Error ? e.message : e) }; }
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    return { text: textOf(content), usage: total };
  }
  // Вичерпали ходи → фінальний виклик БЕЗ client-інструментів (примус тексту), але серверні
  // лишаємо: історія може містити незавершений server_tool_use, і виклик без нього дав би 400.
  const final = await callMessagesRaw(env, system, messages, maxTokens, model, serverTools.length ? serverTools : undefined);
  add(final.usage);
  return { text: textOf(final.content), usage: total };
}

export async function chatAdvice(
  env: Env,
  context: unknown,
  messages: ChatMsg[],
  opts?: { tools?: ChatTool[]; executor?: ToolExecutor },
): Promise<{ text: string; usage: AnthropicUsage }> {
  const today = new Date().toISOString().slice(0, 10);
  // Demo: no server-side web_search (billed per search on top of tokens) and a shorter tool loop.
  // The prompt must match what is actually sent — describing a tool the request does not carry
  // makes the model try to call it and waste a turn. `demoClamp` still strips it as a backstop.
  const demo = isDemoEnv(env);
  const toolNote = opts?.tools?.length
    ? `Сьогодні ${today}. У тебе Є ІНСТРУМЕНТИ (tools) для запитів до ПОВНОЇ бази операцій користувача (не лише контекст вище): ` +
      "query_spend (сума витрат/доходу за період з фільтром по категорії/мерчанту й групуванням), find_transactions (знайти конкретні " +
      "операції), list_categories (перелік категорій). ВИКОРИСТОВУЙ їх, коли фіксованого контексту не вистачає — напр. питання про " +
      "конкретний період/категорію/мерчанта в минулому («скільки на таксі влітку торік», «мої найбільші покупки в грудні»). Сам обчислюй " +
      "дати періодів (YYYY-MM-DD) відносно сьогодні. НЕ вигадуй числа — якщо треба точні дані поза контекстом, виклич інструмент. " +
      "Операції з інструментів теж можна цитувати як [tx:ID|підпис]. " +
      (demo
        ? ""
        : "Ще Є web_search — пошук в офіційних джерелах (курс НБУ, тарифи, податки, ціни) для АКТУАЛЬНИХ фактів " +
          "про світ, яких нема в тренувальних даних; використовуй його ЛИШЕ для зовнішніх фактів (не для особистих " +
          "операцій користувача) і посилайся на джерело. ")
    : "";
  // §A5: стабільний блок (корпус знань + персона/правила) з cache_control ttl:1h — байт-ідентичний
  // між викликами й користувачами, тож читається з кешу ≈0.1×. Динамічний контекст — окремим блоком
  // ПІСЛЯ (не кешується). Це ще й здешевлює: персона раніше слалась щоразу без кешу.
  const stableRules =
    "Ти — досвідчений персональний фінансовий менеджер користувача у застосунку Money Track (не безликий бот, а радник " +
    "«зі стажем», який веде саме ЙОГО гроші). Відповідай українською, по-людськи, по суті. Твоя робота — не лише " +
    "констатувати цифри, а РАДИТИ РІШЕННЯ: куди спрямувати гроші, платити зараз чи почекати, що різати першим, як " +
    "розтягнути подушку, коли безпечно витратити. Думай як менеджер, що дбає про клієнта: пріоритети, тайминг, ризик. " +
    "Коли питання просте — стисло; коли складне чи користувач просить розібратись/порадити — відповідай ДЕТАЛЬНО й " +
    "структуровано (короткий висновок → пояснення на його числах → 2-4 конкретні дієві кроки з ефектом у грн). " +
    "⚠️ КОШТИ (критично — не плутай): liquid_cushion_uah — реальна ліквідна ПОДУШКА (готівка/картки/банки), це головне " +
    "число для «скільки протягну». debt_uah — використаний кредитний ЛІМІТ (це БОРГ, а не «мінус запас»). " +
    "investment_reserve_uah — крипта/брокер: остання лінія оборони, НЕ подушка й НЕ входить у runway; не радь її чіпати, " +
    "поки ситуація не критична. own_funds_uah = подушка − борг (нетто). accounts — рахунки з роллю та описом (note): " +
    "враховуй їх, не домислюй сум поза контекстом. runway_months = подушка / burn. " +
    "⚠️ ПЕРІОДИ: monthly_burn_uah та avg_month_uah — це вже СЕРЕДНЄ НА МІСЯЦЬ; spent_90d_uah — сума за 90 днів. " +
    "Порівнюючи з доходом чи burn — бери місячні числа; НЕ називай 90-денну суму місячною. recent_oneoff — разові " +
    "витрати (податки/лікар): не проектуй їх як регулярні. upcoming_charges — найближчі списання (in_days): спирайся на " +
    "них для порад про тайминг платежів. " +
    "Форматування — markdown: **жирний** для акцентів, списки «- », короткі підзаголовки. " +
    "Якщо в контексті є transactions:[{id,label}] і доречно послатися на конкретну операцію — цитуй її як " +
    "[tx:ID|короткий підпис] (напр. [tx:abc|MrGrill 150₴]); застосунок зробить із цього клікабельний чип. " +
    "📊 ВІЗУАЛІЗАЦІЇ — використовуй ОЩАДЛИВО, лише коли вони справді допомагають зрозуміти (порівняння кількох чисел, " +
    "розклад, план по місяцях). НЕ додавай графік/таблицю до кожної відповіді й ніколи — коли достатньо речення. " +
    "Максимум одна візуалізація на відповідь, лише з реальних чисел контексту.\\n" +
    "• Міні-графік (горизонтальні бари для порівняння): рядок «[chart:Заголовок]», далі по рядку «Підпис|число» " +
    "(число у грн, без символів), закрий «[/chart]». Приклад: [chart:Витрати по категоріях]\\nПродукти|4500\\nКафе|3200\\n[/chart]. Макс 6 рядків.\\n" +
    "• Таблиця (коли треба кілька колонок, напр. план погашення чи ліміт vs факт): рядок «[table:Заголовок]», далі " +
    "рядок заголовків «Кол1|Кол2|Кол3», далі рядки даних так само через «|», закрий «[/table]». Макс 6 рядків даних, 4 колонки.";
  const system: AnthropicContentBlock[] = [
    // Корпус = вбудовані доки + користувацький шар (нотатки/заміни з `knowledge_docs`).
    // Блок лишається СТАБІЛЬНИМ між викликами (детермінований порядок), тож prompt-cache
    // працює як раніше; текст міняється лише коли користувач сам відредагував документ.
    { type: "text", text: (await buildKnowledgeCorpus(env.DB)) + "\n\n---\n\n" + stableRules, cache_control: { type: "ephemeral", ttl: "1h" } },
    {
      type: "text",
      text:
        toolNote +
        "Ось повний фінансовий контекст користувача (суми в грн): " + JSON.stringify(context) +
        ". Спирайся ЛИШЕ на ці дані; якщо потрібної інформації нема — скажи чесно, не вигадуй транзакцій чи чисел." +
        (await replyLangDirective(env, "conversation")),
    },
  ];
  const model = await getTaskModel(env, "chat");
  // §AGENT: якщо передано інструменти — ведемо агентний діалог; інакше звичайний виклик.
  if (opts?.tools?.length && opts.executor) {
    // §A3: додаємо серверний web_search (варіант за моделлю) — актуальні курси/тарифи/ціни.
    const serverTools = demo ? [] : [webSearchTool(model)];
    // Each turn is a separate billed request AND a separate `demoAiGate` hit, so a demo sandbox
    // gets a shorter loop: 6 turns of one question could eat half its whole session allowance.
    const maxTurns = demo ? 3 : 6;
    const { text, usage } = await runToolConversation(env, system, messages, opts.tools, opts.executor, 1500, model, maxTurns, serverTools);
    return { text: text.trim(), usage };
  }
  // §R6/§CTX: детальні відповіді менеджера — більший ліміт виводу.
  const { text, usage } = await callHaikuMessages(env, system, messages, 1500, model);
  return { text: text.trim(), usage };
}

// Багатоходовий діалог, що очікує JSON-відповідь (для інлайн-чату по транзакції):
// парсимо текст як JSON, при збої — 1 ретрай зі суворою вказівкою.
async function callHaikuMessagesJson<T>(
  env: Env,
  system: AnthropicContentBlock[],
  messages: ChatMsg[],
  maxTokens = 700,
  model: string = MODEL_FAST,
): Promise<{ result: T; usage: AnthropicUsage }> {
  const first = await callHaikuMessages(env, system, messages, maxTokens, model);
  try {
    return { result: parseJson<T>(first.text), usage: first.usage };
  } catch {
    // Обірвано по ліміту → більше токенів (не сварка); інакше — суворо просимо чистий JSON.
    const truncated = first.stop === "max_tokens" && !first.capped;
    const retryTokens = truncated ? Math.min(Math.round(maxTokens * 1.8), 8000) : maxTokens;
    const retry: ChatMsg[] = truncated
      ? messages
      : [...messages, { role: "user", content: "Поверни ЛИШЕ валідний JSON-обʼєкт, без тексту до/після." }];
    const second = await callHaikuMessages(env, system, retry, retryTokens, model);
    return { result: parseJson<T>(second.text), usage: second.usage };
  }
}

// Інлайн-чат по КОНКРЕТНІЙ операції: людяна відповідь + опційне оновлення розуміння
// (категорія / прапорець переказу). Модель міняє категорію лише за чіткої підстави з розмови.
export interface TxChatResult {
  reply: string;                 // 1-3 речення живою мовою (можна легкий markdown)
  category_id?: number | null;   // id з переліку — ЛИШЕ якщо треба змінити категорію
  is_transfer?: boolean;         // true, якщо стало ясно, що це переказ між своїми
  understanding?: string | null; // оновлений короткий здогад «що це»
}

export async function txChat(
  env: Env,
  ctx: unknown,
  messages: ChatMsg[],
): Promise<{ result: TxChatResult; usage: AnthropicUsage }> {
  const base = await buildSystemPrefix(
    env,
    "це діалог користувача про КОНКРЕТНУ банківську операцію (її контекст — нижче). Допоможи зрозуміти чи " +
      "уточнити операцію, відповідай стисло українською. Якщо користувач прямо каже, ЩО це (напр. «це відпочинок», " +
      "«це продукти», «поверни в кафе»), або з розмови стало однозначно ясно — онови категорію (враховуй синоніми: " +
      "відпочинок/дозвілля→Розваги, їжа→Продукти тощо). Відповідай ВИКЛЮЧНО валідним JSON: {reply (1-3 речення, " +
      "можна **жирний**), category_id (id основної категорії з переліку — ЛИШЕ якщо треба змінити; інакше пропусти поле), " +
      "is_transfer (true якщо стало ясно, що це переказ між своїми рахунками; інакше пропусти поле), " +
      "understanding (оновлений короткий здогад «що це» або null)}. НЕ міняй категорію без чіткої підстави з розмови. " +
      "У контексті є user_note (нотатка користувача до операції) та user_profile (опис користувача) — ОБОВʼЯЗКОВО " +
      "враховуй їх: якщо користувач уже пояснив, що це, спирайся на це, а не ігноруй. " +
      "Якщо це НАДХОДЖЕННЯ і користувач каже, що це його зарплата / дохід / вивід власних коштів (напр. вивів " +
      "криптозарплату переказом від людини) — постав «Зарплата» (чи названий дохід) і опиши розуміння саме так; " +
      "НЕ називай це «Подарунком» і не пиши «переказ від приватної особи», якщо користувач прямо сказав інше.",
  );
  const system: AnthropicContentBlock[] = [
    ...base,
    // This inline chat had NO language directive at all (found while fixing B6) — its prose
    // answer simply inherited the Ukrainian prompt regardless of who was reading.
    { type: "text", text: "Контекст операції (суми в її валюті): " + JSON.stringify(ctx) + (await replyLangDirective(env, "conversation")) },
  ];
  return callHaikuMessagesJson<TxChatResult>(env, system, messages, 700, await getTaskModel(env, "chat"));
}

function extractBalanced(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Рятуємо ОБІРВАНИЙ (truncated по max_tokens) JSON: доходимо до останньої структурної
// межі (кома/закрита дужка), відкидаємо неповний хвіст і дозакриваємо відкриті дужки/рядок.
// Це головна причина «AI повернув невалідний JSON» — довгі proposals/advice не вміщались.
function repairTruncatedJson(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  let inStr = false, esc = false, safeCut = -1;
  const stack: string[] = [];
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") { stack.pop(); safeCut = i + 1; }
    else if (ch === ",") safeCut = i; // межа між елементами — безпечно обрізати тут
  }
  if (!stack.length) return text.slice(start); // насправді збалансований
  // Обрізаємо до останньої безпечної межі, тоді перераховуємо відкриті дужки й закриваємо.
  let body = safeCut > start ? text.slice(start, safeCut) : text.slice(start);
  const open: string[] = [];
  let s = false, e = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (s) { if (e) e = false; else if (ch === "\\") e = true; else if (ch === '"') s = false; continue; }
    if (ch === '"') s = true;
    else if (ch === "{" || ch === "[") open.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") open.pop();
  }
  if (s) body += '"';
  body = body.replace(/,\s*$/, "");
  while (open.length) body += open.pop();
  return body;
}

function parseJson<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const extracted = extractBalanced(cleaned);
    if (extracted) {
      try { return JSON.parse(extracted) as T; } catch { /* спробуємо ремонт нижче */ }
    }
    const repaired = repairTruncatedJson(cleaned);
    if (repaired) {
      try { return JSON.parse(repaired) as T; } catch { /* здались */ }
    }
    throw new Error(`AI повернув невалідний JSON: ${text.slice(0, 200)}`);
  }
}

// Виклик Haiku з очікуванням JSON: якщо парсинг падає — 1 ретрай зі суворою
// інструкцією. Централізує крихкість усіх JSON-викликів (§ технічні нотатки).
export async function callHaikuJson<T>(
  env: Env,
  system: AnthropicContentBlock[],
  userContent: unknown[],
  maxTokens = 1024,
  model: string = MODEL_FAST,
  /**
   * Optional completeness check. Returns `null` when the object is acceptable, or a sentence
   * describing what is missing — which is fed straight back to the model for ONE more attempt.
   *
   * Exists because the schema in a system prompt is a request, not a contract: a report that
   * asked for `sections`, `predictions` and `advice` came back as a headline and one long
   * paragraph, valid JSON and obviously incomplete on screen. Same principle as
   * `numbersAreGrounded` — if correctness depends on the model obeying, check it in code.
   */
  validate?: (result: T) => string | null,
): Promise<{ result: T; usage: AnthropicUsage }> {
  const first = await callHaiku(env, system, userContent, maxTokens, model);
  // A demo sandbox is clamped to a few hundred output tokens, so neither retry below can ever
  // succeed there — they would only spend the shared budget twice more for the same stub.
  const truncated = first.stop === "max_tokens" && !first.capped;

  /** Run `validate`; on a complaint, ask once more and keep whichever answer is better. */
  const settle = async (result: T, usage: AnthropicUsage): Promise<{ result: T; usage: AnthropicUsage }> => {
    const complaint = first.capped ? null : validate?.(result);
    if (!complaint) return { result, usage };
    console.warn(`ai/json: неповна відповідь — ${complaint}; перепитую`);
    try {
      const again = await callHaiku(
        env, system,
        [...userContent, { type: "text", text: `Твоя попередня відповідь була НЕПОВНОЮ: ${complaint} Поверни ПОВНИЙ JSON з усіма полями схеми. Не скорочуй: довгий текст має жити в sections, а не в summary.` }],
        Math.min(Math.round(maxTokens * 1.5), 16000), model,
      );
      const retried = parseJson<T>(again.text);
      // Take the retry only if it actually fixed something — a second incomplete answer that is
      // WORSE than the first would otherwise replace a usable report with a worse one.
      if (!validate?.(retried)) return { result: retried, usage: again.usage };
    } catch { /* keep the first answer */ }
    return { result, usage };
  };

  // ⚠️ Обрив по ліміту — ПОМИЛКА, навіть коли відповідь усе одно розпарсилась.
  //
  // Спіймано на реальному звіті: Sonnet упирався в 3000 токенів приблизно на `summary`,
  // `repairTruncatedJson` акуратно дозакривав дужки, `JSON.parse` проходив — і в базу лягав
  // огризок: заголовок є, а розбору, категорій, аномалій і порад немає. Ретраю не було саме
  // тому, що парсинг «удався». Користувач бачив короткий звіт без жодної ознаки збою.
  //
  // Ремонт існує для МАЛФОРМОВАНОГО виводу (зайвий текст, обрізаний хвіст масиву), а не для
  // того, щоб мовчки прийняти піввідповіді. Тож коли модель сказала «мені забракло місця» —
  // перепитуємо з більшим лімітом, і лише якщо й другий раз обірвало, беремо що є.
  if (!truncated) {
    try {
      return await settle(parseJson<T>(first.text), first.usage);
    } catch {
      const second = await callHaiku(
        env, system,
        [...userContent, { type: "text", text: "Твоя попередня відповідь була невалідним JSON. Поверни ЛИШЕ валідний JSON-обʼєкт, без жодного тексту, пояснень чи markdown до або після." }],
        maxTokens, model,
      );
      return await settle(parseJson<T>(second.text), second.usage);
    }
  }

  const retryTokens = Math.min(Math.round(maxTokens * 1.8), 16000);
  console.warn(`ai/json: відповідь обірвано на ${maxTokens} токенах, повторюю з ${retryTokens}`);
  const second = await callHaiku(env, system, userContent, retryTokens, model);
  try {
    return await settle(parseJson<T>(second.text), second.usage);
  } catch {
    // Другий обрив — віддаємо відремонтований перший, щоб користувач отримав бодай щось.
    return { result: parseJson<T>(first.text), usage: first.usage };
  }
}

// Build the system prefix from the live category taxonomy.
// ВАЖЛИВО про кеш (виміряно count_tokens): базовий префікс ≈789 тк, а мінімум кешу
// Haiku 4.5 = 4096 тк — тож cache_control на малому префіксі МОВЧКИ не працює.
// Тому кешування вмикаємо лише коли cached=true (масовий enrich): додаємо великий
// СТАБІЛЬНИЙ гайд (CACHE_GUIDE, також покращує якість) з cache_control, щоб перетнути
// поріг. Поодинокі/інтерактивні виклики лишаємо «лін» (без кешу — малий префікс дешевий).
async function buildSystemPrefix(env: Env, task: string, cached = false): Promise<AnthropicContentBlock[]> {
  const cats = await env.DB.prepare(
    "SELECT id, name, is_income FROM categories ORDER BY is_income, id",
  ).all<{ id: number; name: string; is_income: number }>();
  const taxonomy = (cats.results ?? [])
    .map((c) => `${c.id}: ${c.name}${c.is_income ? " (дохід)" : ""}`)
    .join("\n");

  const head: AnthropicContentBlock = {
    type: "text",
    text:
      "Ти — асистент персонального фінансового трекера. Відповідаєш ВИКЛЮЧНО валідним JSON, " +
      "без пояснень і без markdown-огорожі. Суми — числом у валюті чека/тексту (не в копійках). " +
      `Задача: ${task}.\n\nДоступні категорії (id: назва):\n${taxonomy}`,
  };

  if (cached) {
    // Стабільний префікс (гайд + приклади) з cache_control — читається з кешу в батчі.
    return [head, { type: "text", text: `${FEW_SHOT}\n\n${CACHE_GUIDE}`, cache_control: { type: "ephemeral", ttl: "1h" } }];
  }
  // Лін: без cache_control (малий префікс однаково не кешується, тож не платимо write-премію).
  return [head, { type: "text", text: FEW_SHOT }];
}

const FEW_SHOT = `Приклади якісної категоризації (обирай category_id з переліку вище):
- "кава 45 аромакава" -> напій у кавʼярні -> Кафе і ресторани
- "АТБ 247.30" -> продуктовий магазин -> Продукти
- "uber 120" -> поїздка -> Транспорт
- "netflix 199" -> підписка на сервіс -> Підписки
- "аптека 89" -> ліки -> Здоровʼя
- "нова пошта 70" -> доставка -> Інше
- "wog 900" -> заправка -> Транспорт
- "сільпо 512" -> продукти -> Продукти
Якщо категорія неясна — став category_guess у найближчу, не вигадуй нову.`;

// Великий СТАБІЛЬНИЙ гайд для кешованого префікса (cached=true у buildSystemPrefix).
// Дві мети: (1) перетнути мінімум кешу Haiku (4096 тк), щоб масовий enrich читав кеш;
// (2) реально підняти якість категоризації (детальні підказки + багато прикладів UA-мерчантів).
// Тримати стабільним (будь-яка зміна інвалідує кеш) — правити лише свідомо.
const CACHE_GUIDE = `ДЕТАЛЬНИЙ ГАЙД ПО КАТЕГОРІЯХ (обирай найточніший id; підкатегорії можна, вони згортаються в батька):

ВИТРАТИ — основні категорії та коли їх обирати:
- Продукти (1): будь-які продуктові магазини й супермаркети. Підкатегорії: Супермаркет (30) — АТБ, Сільпо, Ашан, Novus, Metro, Varus, Fora, Таврія; Ринок (31) — стихійні ринки, «базар», овочі/фрукти з рук. Якщо це мережевий супермаркет — Супермаркет (30); дрібний магазин біля дому — Продукти (1).
- Кафе і ресторани (2): їжа й напої поза домом. Підкатегорії: Кава (32) — кавʼярні, «coffee», аромакава, Blur, Львівська майстерня кави, стакан кави на виніс; Ресторани (33) — повноцінні заклади, обід/вечеря, McDonald's, KFC, суші, піцерія; Доставка їжі (34) — Glovo, Bolt Food, Rocket, Menu, замовлення їжі додому. Барна вечеря/алкоголь у закладі — Ресторани (33).
- Транспорт (3): пересування. Підкатегорії: Таксі (35) — Uber, Bolt, Uklon, Opti; Пальне (36) — WOG, OKKO, UPG, SOCAR, Shell, АЗС, заправка; Громадський (37) — метро, автобус, маршрутка, тролейбус, е-квиток, поповнення транспортної картки. Каршеринг/оренда авто — Транспорт (3). Нова пошта/Укрпошта — це доставка → Інше (14), а не Транспорт.
- Здоровʼя (4): медицина. Підкатегорії: Аптека (40) — аптеки, ліки, «pharmacy», Аптека доброго дня, Подорожник, ANC; Лікар (41) — клініки, аналізи, стоматолог, Dobrobut, Сінево, Медіком, консультації. Оптика/окуляри — Здоровʼя (4).
- Одяг і взуття (5): одяг, взуття, аксесуари — Zara, H&M, Reserved, Intertop, LC Waikiki, Sinsay, взуття, сумки.
- Розваги (6): дозвілля. Підкатегорії: Кіно (38) — кінотеатри, Multiplex, Планета Кіно, квитки на фільм; Ігри (39) — Steam, PlayStation, Xbox, ігрові покупки, донат у грі. Концерти, боулінг, квести, бар «просто випити» — Розваги (6).
- Комуналка і звʼязок (7): комунальні, інтернет, мобільний — Київстар, Vodafone, lifecell, ОТ «Київенерго», газ, вода, світло, ОСББ, домофон, Ланет, Воля, інтернет-провайдер.
- Дім і побут (8): товари для дому, госптовари, меблі, ремонт, побутова хімія — JYSK, IKEA, Епіцентр, Нова лінія, Comfy (для дому), декор, посуд, лампочки, засоби для прибирання.
- Електроніка (9): гаджети й техніка — Rozetka, Comfy, Foxtrot, Allo, Apple, телефон, ноутбук, навушники, зарядка, аксесуари до техніки.
- Краса і догляд (10): б'юті — перукар, барбершоп, манікюр, косметика, EVA, Watsons, Prostor, парфуми, spa, косметолог.
- Подорожі (11): поїздки — авіаквитки, готелі, Booking, Airbnb, hostel, потяг Укрзалізниця (міжміський), тури, оренда житла в іншому місті.
- Підписки (12): регулярні цифрові платежі. Підкатегорії: Стрімінги (42) — Netflix, Spotify, YouTube Premium, MEGOGO, Apple Music, Disney+; Софт і хмара (43) — Anthropic, OpenAI/ChatGPT, Claude, Cloudflare, GitHub, Google One, iCloud, Adobe, Notion, хостинг, домен, VPN. Регулярний однаковий платіж сервісу → Підписки (12).
- Освіта (19): навчання — курси, Prometheus, Coursera, Udemy, репетитор, книги для навчання, університет, мовна школа, воркшопи.
- Діти (20): дитячі витрати — іграшки, дитячий одяг, садок, гуртки, памперси, дитяче харчування, Antoshka.
- Тварини (21): улюбленці — зоомагазин, корм, ветеринар, Masterzoo, засоби для тварин.
- Спорт і фітнес (22): спорт — абонемент у зал, Sport Life, спортивне харчування, Decathlon, інвентар, басейн, йога.
- Подарунки (23): подарунки іншим — квіти, сувеніри, подарункові набори, «на день народження».
- Податки (24): податки й держзбори. Підкатегорії: Єдиний податок (25) — ЄП ФОП; ЄСВ (26) — єдиний соцвнесок; Військовий збір (27); ПДФО (28) — податок з доходів. «Сплата податку», «ЄП», «ЄСВ», казначейство, ДПС — сюди.
- Дім і побут vs Електроніка: побутова техніка для дому (пилосос, чайник) — залежно від контексту, дрібне для дому → Дім і побут (8), гаджети → Електроніка (9).
- Перекази і зняття (13): зняття готівки в банкоматі, перекази на картку/між своїми, поповнення банки, card-to-card. НЕ вгадуй тут реальну категорію в основному полі — лишай бакет 13.
- Інше (14): доставка (Нова пошта, Укрпошта, Meest), пошта, не класифіковане, разові дрібниці без явної категорії, штрафи, комісії банку.

НАДХОДЖЕННЯ:
- Зарплата (15): регулярна зарплата, аванс.
- Фріланс (16): оплата за роботу/послуги, інвойси, Upwork, Deel, Payoneer-виплати за роботу.
- Повернення (17): повернення коштів, рефанд, скасована покупка.
- Продаж (44): продаж речей — OLX, Prom, продаж власного майна.
- Кешбек (45): кешбек банку, бонуси, повернення відсотком.
- Проценти (46): відсотки на залишок, депозит, нараховані проценти.
- Подарунок (47): гроші в подарунок, отримані від когось.
- Інші надходження (18): що не підпадає під інші доходи.

БІЛЬШЕ ПРИКЛАДІВ (сирий опис -> міркування -> категорія id):
- "ATB 320.50" -> супермаркет АТБ -> Супермаркет (30)
- "SILPO" -> супермаркет Сільпо -> Супермаркет (30)
- "NOVUS" -> супермаркет -> Супермаркет (30)
- "WOG 1200" -> заправка пальним -> Пальне (36)
- "OKKO FUEL" -> заправка -> Пальне (36)
- "BOLT" -> поїздка таксі -> Таксі (35)
- "UKLON" -> таксі -> Таксі (35)
- "GLOVO" -> доставка їжі -> Доставка їжі (34)
- "BOLT FOOD" -> доставка їжі -> Доставка їжі (34)
- "MCDONALDS" -> ресторан фастфуд -> Ресторани (33)
- "KFC" -> фастфуд -> Ресторани (33)
- "aromakava" -> кавʼярня -> Кава (32)
- "lviv coffee" -> кавʼярня -> Кава (32)
- "NETFLIX.COM" -> стрімінг -> Стрімінги (42)
- "SPOTIFY" -> музика підписка -> Стрімінги (42)
- "YOUTUBEPREMIUM" -> підписка -> Стрімінги (42)
- "ANTHROPIC" -> AI-сервіс підписка -> Софт і хмара (43)
- "OPENAI" -> AI-сервіс -> Софт і хмара (43)
- "CLOUDFLARE" -> хмара/хостинг -> Софт і хмара (43)
- "GITHUB" -> dev-сервіс -> Софт і хмара (43)
- "GOOGLE ONE" -> хмара -> Софт і хмара (43)
- "APTEKA ANC" -> аптека -> Аптека (40)
- "SINEVO" -> лабораторія аналізів -> Лікар (41)
- "DOBROBUT" -> клініка -> Лікар (41)
- "ROZETKA" -> техніка/маркетплейс -> Електроніка (9)
- "COMFY" -> техніка -> Електроніка (9)
- "EPICENTR" -> товари для дому -> Дім і побут (8)
- "JYSK" -> дім -> Дім і побут (8)
- "ZARA" -> одяг -> Одяг і взуття (5)
- "SINSAY" -> одяг -> Одяг і взуття (5)
- "EVA" -> косметика/догляд -> Краса і догляд (10)
- "WATSONS" -> догляд -> Краса і догляд (10)
- "KYIVSTAR" -> мобільний/інтернет -> Комуналка і звʼязок (7)
- "VODAFONE" -> мобільний -> Комуналка і звʼязок (7)
- "STEAM" -> ігри -> Ігри (39)
- "PLAYSTATION" -> ігри -> Ігри (39)
- "MULTIPLEX" -> кіно -> Кіно (38)
- "BOOKING.COM" -> готель -> Подорожі (11)
- "UZ KVYTKY" -> квиток УЗ міжміський -> Подорожі (11)
- "MASTERZOO" -> зоомагазин -> Тварини (21)
- "SPORTLIFE" -> спортзал -> Спорт і фітнес (22)
- "ANTOSHKA" -> дитячі товари -> Діти (20)
- "PROMETHEUS" -> онлайн-курси -> Освіта (19)
- "Сплата ЄП" -> єдиний податок -> Єдиний податок (25)
- "ЄСВ ФОП" -> єдиний соцвнесок -> ЄСВ (26)
- "Військовий збір" -> податок -> Військовий збір (27)
- "Нова Пошта" -> доставка -> Інше (14)
- "Зняття готівки ATM" -> готівка -> Перекази і зняття (13)
- "Переказ на картку" -> card-to-card -> Перекази і зняття (13)
- "На банку" -> поповнення власної банки -> Перекази і зняття (13)
Якщо мерчант нижче невідомий — став найближчу за змістом категорію, не вигадуй нову; при повній неоднозначності — Інше (14).`;

// 6.1 Receipt photo -> line items.
export interface ReceiptResult {
  store: string | null;
  purchased_at: string | null;
  currency: string;
  total: number;
  items: { name: string; qty: number; price: number }[];
}

export async function readReceipt(
  env: Env,
  imageBase64: string,
  mediaType: string,
): Promise<{ result: ReceiptResult; usage: AnthropicUsage }> {
  const system = await buildSystemPrefix(
    env,
    "розпізнати чек із фото і повернути JSON {store, purchased_at (ISO), currency, total, items:[{name, qty, price}]}",
  );
  return callHaikuJson<ReceiptResult>(env, system, [
    { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
    { type: "text", text: "Розпізнай цей чек. Поверни лише JSON." },
  ]);
}

// 6.2 Quick text entry -> structured record.
export interface TextResult {
  merchant: string;
  amount: number;
  currency: string;
  category_guess: number | null;
  note: string | null;
}

export async function parseText(
  env: Env,
  input: string,
): Promise<{ result: TextResult; usage: AnthropicUsage }> {
  const system = await buildSystemPrefix(
    env,
    "розпарсити швидкий текстовий запис витрати у JSON {merchant, amount, currency, category_guess (id або null), note}",
  );
  return callHaikuJson<TextResult>(env, system, [{ type: "text", text: input }]);
}

// Enrich a single transaction from its raw bank fields — understand what it actually
// is, pick a category, flag transfers/withdrawals, suggest secondary tags. Reuses the
// cached taxonomy prefix, so a batch of enrichments is cheap.
export interface EnrichResult {
  clean_name: string;      // людська назва замість сирого опису
  category_id: number | null;
  kind: "expense" | "income" | "transfer" | "withdrawal";
  tag_ids: number[];       // до 3 вторинних категорій-тегів (не сумуються)
  note: string | null;     // короткий здогад, що це, для контексту
}

export async function enrichTransaction(
  env: Env,
  tx: {
    merchant: string | null; comment: string | null; mcc: number | null;
    amount: number; currency_code: number; history?: string | null;
    user_note?: string | null; current_category?: string | null; profile?: string | null;
    subscriptions?: string | null;
  },
): Promise<{ result: EnrichResult; usage: AnthropicUsage }> {
  const system = await buildSystemPrefix(
    env,
    "визначити суть банківської транзакції за сирими полями і повернути JSON " +
      "{clean_name (людська назва бренду), category_id (id основної категорії або null), " +
      // Промт цілком українською, тож модель за інерцією «олюднювала» латиницю в кирилицю:
      // «SILPO» приїжджало як «Силпо». Назва мерчанта — це ім'я власне й ключ, за яким
      // сходяться merchant_alias/консенсус/сторінка мерчанта, тож транслітерація ще й дробить
      // історію одного магазину на два різні написання.
      "⚠️ clean_name — ІМʼЯ ВЛАСНЕ: зберігай написання бренду з raw_description, НЕ транслітеруй " +
      "і НЕ перекладай (SILPO → «Silpo», НЕ «Силпо»; NOVUS → «Novus»). Якщо в описі назва вже " +
      "кирилицею — лишай кирилицею. Прибирай лише банківський шум: номери терміналів, міста, коди. " +
      "kind ('expense'|'income'|'transfer'|'withdrawal'; transfer=переказ між своїми рахунками/округлення, " +
      "withdrawal=зняття готівки), tag_ids (масив 0-3 id вторинних категорій), note (короткий здогад або null)}. " +
      "ПРІОРИТЕТ №1 — user_note: якщо користувач прямо написав, що це (напр. «це відпочинок», «подарунок», " +
      "«це Розваги», «це моя зарплата»), став саме ту категорію, яку він має на увазі (враховуй синоніми: відпочинок/дозвілля→Розваги, " +
      "їжа→Продукти тощо). ПРІОРИТЕТ №2 — current_category: якщо користувач уже вручну обрав категорію, НЕ перетирай " +
      "її на «Інше» без вагомих підстав із полів; лишай як є або уточнюй у її межах. " +
      "НАДХОДЖЕННЯ (sign=надходження): вхідний переказ від приватної особи (навіть без магазину/MCC 4829) — це НЕ " +
      "автоматично «Подарунок». Якщо користувач каже (в user_note чи профілі), що це його зарплата / дохід / вивід " +
      "власних коштів (напр. вивів криптозарплату через P2P) — став «Зарплата» або відповідний дохід, а не «Подарунок». " +
      "«Подарунок» лише коли справді схоже на дарунок і немає інших вказівок. " +
      "Якщо є user_profile — це опис користувача та його ситуації; використовуй для контексту (напр. фрилансер → " +
      "деякі списання це податки/робочі витрати). Якщо є merchant_history — раніше користувач класифікував цього " +
      "мерчанта; узгоджуйся, якщо не суперечить вище. Якщо є known_subscriptions — це оголошені користувачем " +
      "регулярні підписки зі схожою назвою; коли операція скидається на списання такої підписки, став саме ту категорію.",
    true, // §R6: вмикаємо детальний гайд (Spotify→Стрімінги тощо) + активує prompt-кеш для bulk-enrich.
  );
  const amountMajor = tx.amount / 100;
  const payload = {
    raw_description: tx.merchant,
    bank_comment: tx.comment,
    mcc: tx.mcc,
    amount: amountMajor,
    currency_code: tx.currency_code,
    sign: tx.amount < 0 ? "витрата" : "надходження",
    merchant_history: tx.history ?? null,
    user_note: tx.user_note ?? null,
    current_category: tx.current_category ?? null,
    user_profile: tx.profile ?? null,
    known_subscriptions: tx.subscriptions ?? null,
  };
  // Модель за задачею (рішення користувача 2026-07-14): коли користувач САМ описав операцію
  // нотаткою (user_note) — беремо розумний Sonnet для розпізнання (він поважає пояснення й не
  // плутає «зарплату/вивід» з «подарунком»). Масовий/авто-enrich без нотатки лишається на дешевому Haiku.
  const model = tx.user_note?.trim() ? MODEL_SMART : MODEL_FAST;
  return callHaikuJson<EnrichResult>(env, system, [
    { type: "text", text: `Проаналізуй транзакцію і поверни лише JSON:\n${JSON.stringify(payload)}` },
  ], 1024, model);
}

// §F2 крок 2: для операції у бакеті «Перекази і зняття» (зняття готівки, card-to-card)
// AI здогадується про РЕАЛЬНУ категорію витрати — на що ці кошти пішли насправді.
// Повертає real_category_id (id основної категорії) або null, якщо це справжній
// внутрішній рух власних коштів / визначити неможливо. Вторинну класифікацію лишаємо.
export interface TransferCategoryResult {
  real_category_id: number | null;
  note: string | null; // короткий здогад укр. або null
  confidence: "high" | "low"; // low → рядок «потребує уваги» в рев'ю (§R2-ST4)
}

export async function proposeTransferCategory(
  env: Env,
  tx: { merchant: string | null; comment: string | null; mcc: number | null; amount: number; currency_code: number; history?: string | null; hint?: string | null },
  model: string = MODEL_FAST,
): Promise<{ result: TransferCategoryResult; usage: AnthropicUsage }> {
  const system = await buildSystemPrefix(
    env,
    "це операція-переказ або зняття готівки. Визнач РЕАЛЬНУ категорію витрати — на що кошти " +
      "пішли насправді (зняв готівку → найімовірніша побутова категорія на кшталт «Продукти» чи «Інше»; " +
      "переказ конкретному сервісу/людині за товар/послугу → відповідна категорія). Поверни JSON " +
      "{real_category_id (id основної категорії-витрати або null), note (короткий здогад укр. або null), " +
      "confidence ('high' якщо впевнений; 'low' якщо це радше здогад і варто перепитати користувача)}. " +
      "Якщо це справжній рух власних коштів між своїми рахунками/банками/округлення — real_category_id = null. " +
      "Якщо є user_hint — це уточнення користувача саме про цю операцію; довіряй йому найбільше. " +
      "Якщо є merchant_history — узгоджуйся з ним.",
  );
  const payload = {
    raw_description: tx.merchant,
    bank_comment: tx.comment,
    mcc: tx.mcc,
    amount: tx.amount / 100,
    currency_code: tx.currency_code,
    merchant_history: tx.history ?? null,
    user_hint: tx.hint ?? null,
  };
  return callHaikuJson<TransferCategoryResult>(env, system, [
    { type: "text", text: `Проаналізуй операцію і поверни лише JSON:\n${JSON.stringify(payload)}` },
  ], 1024, model);
}

// AI-планувальник бюджету (§ візія): з історії витрат + ситуації користувача пропонує
// місячні ліміти-конверти по кожній категорії з коротким обґрунтуванням.
export interface BudgetPlan {
  proposals: { category_id: number; limit_uah: number; reason: string }[];
  overall: string;
}

export async function proposeBudgetLimits(
  env: Env,
  payload: unknown,
): Promise<{ result: BudgetPlan; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "Ти — фінансовий планувальник. На основі ситуації користувача (situation), його чисел " +
        "(власні кошти, місячний burn, runway у місяцях) та середніх витрат по категоріях за 3 місяці " +
        "(categories: [{id, name, avg_month_uah, current_limit_uah}]) запропонуй розумні МІСЯЧНІ ліміти-конверти " +
        "по КОЖНІЙ поданій категорії (те саме id). Якщо runway малий або мета — економія, пропонуй реалістичне " +
        "скорочення дискреційних витрат (розваги, кафе, підписки, одяг), але не ріж надмірно базові (продукти, " +
        "комуналка, здоровʼя). Ліміти — цілі числа в гривнях, не завищені й не нульові. Відповідай ВИКЛЮЧНО " +
        "валідним JSON: {proposals:[{category_id, limit_uah, reason}], overall} — reason 1 короткою фразою " +
        "(укр.), overall — 1-2 речення про логіку плану. Без markdown.",
    },
  ];
  return callHaikuJson<BudgetPlan>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 2200, await getTaskModel(env, "budget"));
}

// Спільний структурований «факт» для стилізованого рендеру (гроші/категорії/дельти).
export interface AiFact {
  label: string;
  amount?: number | null;    // грн (major), число або null
  category?: string | null;  // назва категорії, якщо доречно
  delta_pct?: number | null; // зміна проти минулого періоду, +/-
  tone?: "pos" | "neg" | "neutral" | null;
}

// Дія, яку можна виконати прямо з поради (§дієві поради).
export interface AdviceAction {
  type: "create_budget";
  label: string;              // текст кнопки
  category_id?: number | null;
  category_name?: string | null;
  amount_uah?: number | null; // для create_budget — ліміт у грн
}

// Структуровані фінансові поради під ситуацію користувача (§advisor).
export interface AdviceResult {
  runway_comment: string;                         // 1-2 речення про запас/скільки протягнеш
  summary: string;                                // короткий підсумок ситуації
  facts: AiFact[];                                // 2-5 ключових фактів для стилізації
  suggestions: { title: string; detail: string; action?: AdviceAction | null }[]; // 3-5 кроків
}

// Спостереження для стрічки сповіщень (Центр сповіщень, kind='ai'). Модель НЕ рахує —
// вона лише називає людською мовою те, що вже пораховано канонічно (collectFinanceSnapshot).
// Це і є різниця з «тупим алертом»: не «поріг перевищено», а що змінилось і що з цим робити.
export interface NotifyObservation { title: string; body: string; severity?: string }
export async function generateNotifyObservations(
  env: Env,
  payload: unknown,
): Promise<{ result: { observations?: NotifyObservation[] }; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "Ти — особистий фінансовий помічник. Дивишся на знімок фінансів користувача і формулюєш " +
        "0-2 КОРОТКІ спостереження для стрічки сповіщень. " +
        "⚠️ ГОЛОВНЕ: використовуй ВИКЛЮЧНО числа з payload. НЕ рахуй нових сум, НЕ множ, НЕ оцінюй «на око», " +
        "НЕ вигадуй цифр, яких у payload немає — краще без числа, ніж із вигаданим. " +
        "Кожну суму, яку пишеш, ти маєш могти показати пальцем у payload; сума, якої там нема, " +
        "автоматично відкидає все спостереження. " +
        "🚫 ЖОДНИХ приблизних форм: не «3600+», не «близько 3 тис», не «~4000» — або точне число з payload, або без числа. " +
        "🚫 ОДНА СУМА ПРО ОДНЕ: якщо назвав суму в title, у body повторюй ЇЇ САМУ, а не іншу оцінку того самого " +
        "(«8 підписок дають 3354 ₴/міс … це 3600+ ₴/міс» — груба помилка, дві різні цифри про одне). " +
        "🚫 НЕ приписуй сумі періоду, якого нема в payload («1070 ₴ за 27 днів»): пиши період так, як він поданий. " +
        "⚠️ ПЕРІОДИ: monthly_burn_uah уже усереднений НА МІСЯЦЬ; у категорій є і spent_90d_uah, і avg_month_uah — " +
        "для порівнянь бери avg_month_uah, не називай 90-денну суму місячною. " +
        "Спостереження має бути ДІЄВИМ: не «витрати зросли», а що саме змінилось і що варто зробити. " +
        "НЕ дублюй те, про що вже є окремі сповіщення: перевищений бюджет, дедлайн підписки, подорожчання, " +
        "аномалія темпу категорії, провал ліквідності, індекс здоровʼя. Шукай те, чого детермінований " +
        "детект НЕ ловить: зміну структури витрат, накопичений ефект дрібних сум, звʼязок між категоріями, " +
        "наслідок ситуації користувача (situation). " +
        "Якщо нічого справді вартого уваги немає — поверни порожній масив. Це нормальна й правильна відповідь: " +
        "мовчання краще за шум. " +
        // Спостереження генеруються ЩОДНЯ на майже незмінному знімку, тож без цього блоку модель
        // щоранку переказує ту саму думку іншими словами («на скільки вистачить запасу»), і
        // Telegram перетворюється на щоденну розсилку однієї фрази. Дедуп за змістом стоїть і в
        // коді (`notify.ts`), але він ловить лише однакове формулювання — тему ловити тут.
        "🚫 НЕ ПОВТОРЮЙСЯ: у payload є recent_observation_titles — теми, про які ти вже писав " +
        "останні два тижні. Не переказуй їх іншими словами (навіть якщо число трохи змінилось) — " +
        "шукай НОВЕ. Якщо нового нема, порожній масив краще за перефразування. " +
        "МОВА: природна українська. title — іменникова фраза, як заголовок новини " +
        "(«Кредитний борг зʼїдає подушку», а НЕ «Мініатюрний дохід vs квартира не робить»). " +
        "Жодних англійських слів і внутрішніх термінів у тексті: не «optional/discretionary», а " +
        "«необовʼязкові витрати»; не «burn», а «витрати на місяць»; не «runway», а «запас/на скільки вистачить». " +
        "title ≤ 60 символів, body ≤ 200 символів, без markdown. " +
        'Відповідай ВИКЛЮЧНО валідним JSON: {"observations":[{"title","body","severity":"info"|"warn"}]}' +
        (await replyLangDirective(env)),
    },
  ];
  return callHaikuJson<{ observations?: NotifyObservation[] }>(
    env, system, [{ type: "text", text: JSON.stringify(payload) }], 700, await getTaskModel(env, "notify"),
  );
}

// P3.4/§12.5: make USER-FACING free-text answers come back in the right language. Structured
// tasks (enrich/OCR/parse) intentionally do NOT use this — their output is ids, and the numeric
// guard (`numbersAreGrounded`) is language-independent.
//
// Two modes, because the two situations have DIFFERENT right answers (B6, 2026-07-26):
//
//   "content"      — generated text with no user utterance to answer (advice, report, insight,
//                    feed observations). The app locale is the only signal, so it wins.
//   "conversation" — the user just wrote a message. Their language wins; the locale is only the
//                    fallback for something too short to judge.
//
// Why the split is not cosmetic: the single old rule ("write everything in English, do NOT reply
// in Ukrainian") was applied to the chat as well. A visitor running the English UI asked a
// question IN UKRAINIAN, and the model — told to avoid both the user's language and its own
// Ukrainian prompt — answered in RUSSIAN, mid-reply, having found a third Slavic language that
// broke neither instruction literally. Hence also the explicit ban below: it is stated in BOTH
// modes, including `uk`, which previously carried no language instruction at all.
const NEVER_RUSSIAN =
  " Never answer in Russian under any circumstances — not a sentence, not a clause, not even if " +
  "the user writes to you in Russian (in that case answer in Ukrainian).";

async function replyLangDirective(env: Env, mode: "content" | "conversation" = "content"): Promise<string> {
  const en = (await getState(env.DB, "locale")) === "en";

  if (mode === "conversation") {
    return " 🌐 RESPONSE LANGUAGE (overrides any language wording above): reply in the SAME language " +
      "the user wrote their latest message in — Ukrainian question, Ukrainian answer; English question, " +
      `English answer. If the message is too short to tell, use ${en ? "English" : "Ukrainian"}. ` +
      "Never mix two languages inside one reply." + NEVER_RUSSIAN;
  }

  return (en
    ? " 🌐 RESPONSE LANGUAGE (overrides any Ukrainian wording above): write EVERYTHING the user reads " +
      "— headlines, advice, labels, section titles, chart/table captions — in natural English. Keep JSON " +
      "keys and enum values (e.g. 'pos'/'neg', 'info'/'warn') exactly as specified; translate only " +
      "human-readable text. Do NOT reply in Ukrainian."
    : " 🌐 RESPONSE LANGUAGE: write everything the user reads in natural Ukrainian.") + NEVER_RUSSIAN;
}

export async function generateAdvice(
  env: Env,
  payload: unknown,
): Promise<{ result: AdviceResult; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "Ти — особистий фінансовий радник. На основі опису ситуації користувача (situation) та його чисел " +
        "(власні кошти, місячний burn, runway у місяцях, топ-категорії, топ-мерчанти) дай практичні поради " +
        "українською. ⚠️ ПЕРІОДИ: monthly_burn_uah вже усереднений НА МІСЯЦЬ; суми top_categories/top_merchants/by_event " +
        "подано і за 90 днів (spent_90d_uah), і на місяць (avg_month_uah). Для порад і порівнянь із доходом/burn " +
        "спирайся на avg_month_uah, а НЕ на 90-денну суму — не називай накопичене за 3 місяці місячним. " +
        "🚫 НЕ «ПО КНИЖЦІ»: ПОВАЖАЙ situation як тверде обмеження. Якщо користувач без роботи / між роботами / шукає — " +
        "НЕ радь абстрактно «збільшити дохід», «додати джерело доходу», «закласти дохід у бюджет». Замість цього: " +
        "подовження runway, ріж optional/discretionary, використання ліквідної подушки. Не давай generic-порад, які " +
        "пасують будь-кому — кожна порада має спиратись на КОНКРЕТНІ його числа/категорії. " +
        "💰 КОШТИ ЧЕСНО: liquid_cushion_uah — реальний запас (заощадження/плюсові рахунки); debt_uah — борг по кредитці. " +
        "own_funds_uah (нетто) може бути ВІД'ЄМНИМ через борг — це НЕ «мінус запас», реальна подушка окремо. Runway рахуй/трактуй " +
        "від подушки. 🏦 РАХУНКИ: у payload accounts — рахунки з роллю (role) та ОПИСОМ (note). role='investment' (крипта/брокер) " +
        "у investment_reserve_uah — це НЕ ліквідна подушка й НЕ входить у runway; згадуй його як окремий резерв/останню лінію, " +
        "не пропонуй продавати інвестиції, поки ситуація не критична. Враховуй note кожного рахунку як контекст. " +
        "recent_oneoff — разові витрати місяця (податки, лікар): НЕ вважай їх регулярними й не проектуй у майбутнє. " +
        "У payload є citable_operations:[{id,label}] — коли згадуєш конкретну операцію в summary чи suggestions.detail, " +
        "встав після назви токен [tx:ID] з відповідним id (напр. «Rozetka [tx:abc]»). Лише наявні id, не вигадуй, 1-2 доречні. " +
        "Будь конкретним і емпатичним, без води й без markdown. Відповідай ВИКЛЮЧНО валідним JSON: " +
        "{runway_comment, summary, " +
        "facts:[{label, amount (грн число або null), category (назва або null), delta_pct (число або null), tone ('pos'|'neg'|'neutral')}] (2-5 ключових фактів), " +
        "suggestions:[{title, detail, action}]} — 3-5 порад, кожна дієва (що саме скоротити/зробити і ефект у грн). " +
        "action — або null, або {type:'create_budget', label, category_id (з top_categories), category_name, amount_uah} " +
        "коли доречно запропонувати ліміт-конверт на категорію. Суми — у гривнях." +
        (await replyLangDirective(env)),
    },
  ];
  return callHaikuJson<AdviceResult>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 2200, await getTaskModel(env, "advisor"));
}

// §Аналітика 2.0: розгорнутий періодичний репорт (Sonnet 5). Детальний розбір по
// категоріях, аномалії, прогнози, дієві поради — на КАНОНІЧНИХ даних (₴), із порівнянням
// до того самого попереднього періоду й урахуванням описів операцій (user_note).
export interface FinancialReport {
  headline: string;                 // 1 рядок — головне за період
  summary: string;                  // 2-4 речення — стан і висновок
  sections: { title: string; body: string }[];              // 2-4 наративні секції
  category_breakdown: { name: string; amount_uah: number; delta_pct: number | null; note: string | null }[];
  anomalies: { label: string; detail: string; severity: "info" | "warn" | "high" }[];
  predictions: { next_period_spend_uah: number | null; runway_months: number | null; note: string | null };
  advice: { title: string; detail: string; action?: AdviceAction | null }[];
}

// §3: діалог про бюджети — AI пропонує/коригує ліміти в розмові й пояснює ЧОМУ.
export interface BudgetChatResult {
  reply: string;
  proposals?: { category_id: number; limit_uah: number; reason: string }[];
}
export async function budgetChat(
  env: Env,
  ctx: unknown,
  messages: ChatMsg[],
): Promise<{ result: BudgetChatResult; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "Ти — помічник із бюджетування. Веди діалог українською про МІСЯЧНІ бюджети-конверти по категоріях. " +
        "Контекст (нижче) має categories:[{id,name,avg_month_uah,current_limit_uah,importance}], own_funds_uah, " +
        "monthly_burn_uah, situation. Радь РЕАЛІСТИЧНІ ліміти на основі avg_month_uah і вагомості: essential " +
        "(обов'язкові) не ріж різко; optional (необов'язкові) можна стискати сильніше. Пояснюй ЧОМУ саме стільки. " +
        "Коли пропонуєш конкретні ліміти — клади їх у proposals, щоб користувач прийняв одним тапом. " +
        "Відповідай ВИКЛЮЧНО валідним JSON: {reply (2-5 речень, можна **жирний**), " +
        "proposals:[{category_id (лише з переліку), limit_uah (ціле грн), reason (коротко чому)}] " +
        "(порожній масив, якщо це просто відповідь без нових пропозицій лімітів)}." +
        (await replyLangDirective(env, "conversation")),
    },
    { type: "text", text: "Контекст: " + JSON.stringify(ctx) },
  ];
  return callHaikuMessagesJson<BudgetChatResult>(env, system, messages, 1400, await getTaskModel(env, "budget"));
}

export async function generateFinancialReport(
  env: Env,
  payload: unknown,
): Promise<{ result: FinancialReport; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "Ти — старший персональний фінансовий аналітик. Побудуй ДЕТАЛЬНИЙ періодичний звіт українською на " +
        "основі поданих КАНОНІЧНИХ даних користувача (усі суми — у гривнях, уже зведені; period описує тип і межі). " +
        "Дані вже коректно порахували (готівка за реальною категорією, перекази між своїми виключені, валюти зведені " +
        "в ₴) — БЕРИ саме ці числа, не перераховуй і не вигадуй. У payload є: current (spend/income/net/savings_rate), " +
        "previous (той самий попередній період — для чесного порівняння), categories (з delta_pct до минулого), " +
        "top_merchants, notable (помітні операції з описами користувача user_note — враховуй їх, щоб не називати " +
        "разове регулярним), anomalies_hint (підказки про подорожчання підписок/викиди), forecast (прогноз/runway), " +
        "by_importance (частка витрат за вагомістю: essential=обов'язкові, discretionary=бажані, optional=необов'язкові — " +
        "у порадах про скорочення цілься в optional/discretionary, а essential не радь різати). " +
        "ВАЖЛИВО (не «по книжці»): поважай user_profile — це реальна ситуація людини; якщо нема активного доходу, " +
        "НЕ рекомендуй загальники типу «наростіть дохід/інвестуйте» — фокус на runway та зрізанні optional/discretionary. " +
        "recurring_vs_oneoff розділяє звичний місячний ритм (recurring) від разових викидів (oneoff: податки, стоматолог, " +
        "велика покупка) — разові НЕ проєктуй у наступний період і НЕ називай трендом. Прогнози став на реальну ПОДУШКУ " +
        "(forecast.cushion_uah — позитивні власні кошти), а НЕ на нетто з кредиткою; борг (forecast.debt_uah) згадуй окремо. " +
        "forecast.investment_reserve_uah (крипта/брокер) — НЕ ліквідна подушка й НЕ входить у runway; це окрема остання лінія, " +
        "не пропонуй продавати інвестиції без крайньої потреби. accounts — рахунки з роллю та ОПИСОМ (note): враховуй note як контекст. " +
        // ⚠️ Явні мінімуми, бо без них модель вивалювала ВЕСЬ звіт в один абзац `summary`, а
        // `sections`/`predictions`/`advice` лишала порожніми — валідний JSON і порожній екран.
        // Перевірка в коді (`validate` нижче) ловить це й перепитує; тут — щоб не доводилось.
        "🔴 ОБОВʼЯЗКОВО ЗАПОВНИ ВСІ ПОЛЯ. `summary` — це 2-4 речення огляду, НЕ місце для всього " +
        "звіту: деталі йдуть у `sections` (2-4 секції), прогноз — у `predictions`, поради — у " +
        "`advice` (3-5 штук), топ-категорії — у `category_breakdown`. Звіт із самим лише summary " +
        "вважається помилковим і буде відхилений. " +
        // §CADENCE — без цього блоку модель порівнювала МІСЯЧНІ платежі тиждень-до-тижня й видавала
        // «підписки впали з 1300₴ до 99₴ (−92%)», хоча це той самий календар: одне списання потрапило
        // у вікно, друге — ні. Прапорці рахує report.ts (детерміновано), тут — що з ними робити.
        "🔴 РИТМ СПИСАНЬ. У categories є charges_n / prev_charges_n (скільки списань дало суму), " +
        "monthly_usual_uah (канонічний МІСЯЧНИЙ рівень категорії) і billing: 'monthly_fixed' = списується " +
        "раз на місяць (підписка, оренда, страховка), 'variable' = багато дрібних покупок. Якщо " +
        "delta_meaningful=false — delta_pct показує ТАЙМІНГ списання, а не зміну поведінки, і подавати його " +
        "як тренд ЗАБОРОНЕНО. Замість «підписки впали на 92%» пиши «цього тижня місячних списань не було; " +
        "звичний рівень — monthly_usual_uah». Так само income_delta_meaningful=false означає, що зарплата чи " +
        "інвойс прийшов іншого тижня, а НЕ що дохід зник — не будуй на цьому ні висновку, ні прогнозу. " +
        "Для періодів, коротших за місяць, порівнюй витрати з monthly_usual_uah, а не лише з previous. " +
        // §NOVELTY — модель повторювала ту саму думку щотижня («квартира забрала багато»), бо
        // найбільша категорія найбільша завжди. Список тем рахує report.ts із попередніх звітів.
        "🔴 НОВИЗНА. already_covered — спостереження, аномалії й поради з ТВОЇХ попередніх звітів. НЕ подавай " +
        "їх як новину вдруге: якщо ситуація не змінилась, дай максимум одну фразу «без змін» і йди далі. " +
        "Найбільша категорія сама по собі — НЕ спостереження («оренда найбільша» правда щомісяця й не додає " +
        "нічого); спостереження — це те, що ЗМІНИЛОСЬ, або те, чого людина не бачить із самої таблиці. " +
        "prior_reports — твої попередні звіти: звір траєкторію, відзнач що покращилось/погіршилось відтоді. " +
        "notable та biggest_expenses мають поле tx_id — коли згадуєш КОНКРЕТНУ операцію в тексті (summary/sections/" +
        "anomalies.detail/advice.detail), встав посилання на неї токеном [tx:ID] одразу після назви (напр. «Rozetka [tx:abc123]»), " +
        "де ID — саме tx_id тієї операції. Використовуй ЛИШЕ наявні tx_id, не вигадуй. Не зловживай — 1-2 цитати там, де доречно. " +
        "Пиши по суті, з конкретними числами й % змін. Відповідай ВИКЛЮЧНО валідним JSON без markdown: " +
        "{headline, summary, sections:[{title, body}] (2-4 секції — куди пішли гроші, що змінилось і чому, ризики), " +
        "category_breakdown:[{name, amount_uah, delta_pct (число або null), note}] (топ-8 категорій, note — 1 фраза), " +
        "anomalies:[{label, detail, severity ('info'|'warn'|'high')}] (незвичні/разові витрати, подорожчання підписок; " +
        "порожній масив якщо нема), predictions:{next_period_spend_uah (число або null), runway_months (число або null), " +
        "note}, advice:[{title, detail, action}] (3-5 дієвих порад з ефектом у грн; action — null або " +
        "{type:'create_budget', label, category_id, category_name, amount_uah})}. Суми — цілі числа гривень." +
        (await replyLangDirective(env)),
    },
  ];
  // 8000, а не 3000: повний звіт українською — це 2-4 секції, 8 категорій, аномалії та 3-5 порад,
  // і кирилиця коштує ~2-3 токени на слово. На 3000 модель стабільно обривалась приблизно на
  // `summary`, а ремонт JSON робив цей обрив невидимим (див. `callHaikuJson`).
  //
  // Валідатор — бо ліміту токенів виявилось мало: маючи 8000, модель однаково повертала лише
  // headline+summary, і на екрані зникали Прогноз, Розбір і Поради. Промт просить — код перевіряє.
  return callHaikuJson<FinancialReport>(
    env, system, [{ type: "text", text: JSON.stringify(payload) }], 8000, await getTaskModel(env, "report"),
    (r) => {
      const missing: string[] = [];
      if (!(r.sections?.length >= 2)) missing.push("розбір (sections, 2-4 секції)");
      if (!(r.advice?.length >= 3)) missing.push("поради (advice, 3-5 штук)");
      if (!r.predictions) missing.push("прогноз (predictions)");
      // `category_breakdown` — єдине з чотирьох, що має детермінований дублікат (ми рахуємо
      // категорії самі), тож його відсутність екран не ламає й на ретрай не тягне.
      return missing.length ? `бракує обовʼязкових полів: ${missing.join(", ")}.` : null;
    },
  );
}

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
        "Ти — фінансовий асистент. На основі агрегованих чисел за період (period_label) склади короткий інсайт " +
        "українською. КОНТЕКСТ у payload: user_profile (реальна ситуація — поважай її, не радь «по книжці»), " +
        "top_anomalies (найбільші зміни сум проти минулого періоду, delta_uah від'ємний = витрати зросли), " +
        "by_importance (essential/discretionary/optional — де можна різати), recurring_vs_oneoff (розділяй звичний " +
        "місячний ритм від разових викидів — top_oneoff це разові, як податки чи стоматолог; НЕ називай їх " +
        "регулярними і НЕ проєктуй їх у майбутнє). Враховуй user_notes — якщо користувач пояснив разову витрату, " +
        "не називай її регулярною. Не вигадуй порад, яких не підтверджують числа. " +
        "Відповідай ВИКЛЮЧНО валідним JSON без markdown: {headline (1 речення — головне за період), " +
        "facts:[{label, amount (грн число або null), category (назва або null), delta_pct (зміна проти минулого " +
        "періоду, число +/- або null), tone ('pos'|'neg'|'neutral')}] (2-5 фактів — куди пішло найбільше, помітні " +
        "зміни, аномалії, розподіл за вагомістю), note (1 коротка конкретна порада або null)}. Суми — у гривнях." +
        (await replyLangDirective(env)),
    },
  ];
  return callHaikuJson<StructuredInsight>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 700, await getTaskModel(env, "insight"));
}

// §GR2: оцінка групи/події — вплив на бюджет, чи дорого, чи варте. Структурований JSON,
// може цитувати конкретні транзакції групи як [tx:ID|короткий підпис] (фронт зробить чип).
export async function evaluateGroup(
  env: Env,
  payload: unknown,
): Promise<{ result: StructuredInsight; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "Ти — фінансовий асистент. Оціни конкретну ГРУПУ витрат користувача (подорож/подія/проєкт) за поданими " +
        "числами (суми в грн): скільки коштувала, як це відносно місячного burn і запасу (runway), чи це дорого, " +
        "куди пішло найбільше, чи є аномалії. Якщо в payload є transactions:[{id,label}] — можеш послатися на " +
        "помітну операцію у facts.label чи note як [tx:ID|короткий підпис] (напр. [tx:abc|MrGrill 150₴]). " +
        "Відповідай ВИКЛЮЧНО валідним JSON без markdown: {headline (1 речення — головний висновок про групу), " +
        "facts:[{label, amount (грн число або null), category (назва або null), delta_pct (null зазвичай), " +
        "tone ('pos'|'neg'|'neutral')}] (2-5), note (1 коротка порада або висновок «дорого/норм» або null)}.",
    },
  ];
  return callHaikuJson<StructuredInsight>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 800, await getTaskModel(env, "group"));
}
