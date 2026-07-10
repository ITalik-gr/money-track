// Claude Haiku 4.5 layer (§6). One key, one model. Stable prompt prefix (system +
// full category list + few-shot) is marked with cache_control so we don't pay for it
// on every call. NOTE (§6.7): Haiku's min cacheable prefix is 4096 tokens — the
// category taxonomy + examples must stay large enough or the cache silently no-ops.
import type { Env } from "../env.ts";
import { getState, setState } from "./repo.ts";

// Гібрид (рішення користувача 2026-07-06): масові/фонові задачі — дешевий Haiku;
// розумні user-facing (чат по операції, поради, розуміння підписок, рев'ю) — Sonnet 5.
export const MODEL_FAST = "claude-haiku-4-5";
export const MODEL_SMART = "claude-sonnet-5";
export const MODEL_OPUS = "claude-opus-4-8";
const API = "https://api.anthropic.com/v1/messages";

// Моделі окремо НА ЗАДАЧУ (рішення 2026-07-11). Кожна user-facing задача має свій ключ
// app_state.ai_model_<task> зі значенням-токеном (haiku|sonnet|opus). Дефолти нижче:
// репорти — Opus (найглибший розбір), порадник/чат/бюджет — Sonnet, AI-огляд — Haiku (масово/дешево).
// Enrich/OCR/categorize НЕ конфігуруються — завжди Haiku.
export type AiTask = "report" | "advisor" | "insight" | "chat" | "budget" | "group";
export const AI_TASK_DEFAULTS: Record<AiTask, string> = {
  report: MODEL_OPUS,
  advisor: MODEL_SMART,
  insight: MODEL_FAST,
  chat: MODEL_SMART,
  budget: MODEL_SMART,
  group: MODEL_SMART,
};
export const MODEL_BY_TOKEN: Record<string, string> = { haiku: MODEL_FAST, sonnet: MODEL_SMART, opus: MODEL_OPUS };
export const TOKEN_BY_MODEL: Record<string, string> = { [MODEL_FAST]: "haiku", [MODEL_SMART]: "sonnet", [MODEL_OPUS]: "opus" };

// Модель для задачі: збережений токен (якщо валідний) інакше дефолт задачі.
export async function getTaskModel(env: Env, task: AiTask): Promise<string> {
  const saved = await getState(env.DB, `ai_model_${task}`);
  if (saved && MODEL_BY_TOKEN[saved]) return MODEL_BY_TOKEN[saved];
  return AI_TASK_DEFAULTS[task];
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

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
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

// Ціни за 1M токенів (USD), станом на 2026-07. Sonnet 5 має інтро-ціну $2/$10 до 2026-08-31,
// але беремо стікер $3/$15 як стабільну оцінку (лічильник — орієнтир, не білінг).
// cache read ≈ 0.1× input; cache write ≈ 1.25× input (5хв) — enrich пише 1h (~2×), тож
// це радше нижня оцінка вартості кешу. Достатньо для «скільки я витратив».
const PRICES: Record<string, { in: number; out: number }> = {
  [MODEL_FAST]: { in: 1.0, out: 5.0 },   // Haiku 4.5
  [MODEL_SMART]: { in: 3.0, out: 15.0 }, // Sonnet 5
  [MODEL_OPUS]: { in: 5.0, out: 25.0 },  // Opus 4.8
};

export function callCostUsd(model: string, u: AnthropicUsage): number {
  const p = PRICES[model] ?? PRICES[MODEL_FAST];
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return (
    (u.input_tokens * p.in +
      u.output_tokens * p.out +
      cacheRead * p.in * 0.1 +
      cacheWrite * p.in * 1.25) /
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
    const cost = callCostUsd(model, u);
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
  maxTokens = 1024,
  model: string = MODEL_FAST,
): Promise<{ text: string; usage: AnthropicUsage }> {
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
  };
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  await recordUsage(env, model, data.usage); // §Хвіст C: акумулюємо вартість усіх викликів
  return { text, usage: data.usage };
}

// Витягнути перший збалансований {...} або [...] блок, толеруючи прозу до/після
// та рядки з екранованими лапками. Haiku інколи додає текст або обриває огорожу.
// Багатоходовий діалог (чат-порадник): приймає повну історію повідомлень.
export interface ChatMsg { role: "user" | "assistant"; content: string }

async function callHaikuMessages(
  env: Env,
  system: AnthropicContentBlock[],
  messages: ChatMsg[],
  maxTokens = 700,
  model: string = MODEL_FAST,
): Promise<{ text: string; usage: AnthropicUsage }> {
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
  const data = (await res.json()) as { content: { type: string; text?: string }[]; usage: AnthropicUsage };
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  await recordUsage(env, model, data.usage); // §Хвіст C: акумулюємо вартість усіх викликів
  return { text, usage: data.usage };
}

export async function chatAdvice(
  env: Env,
  context: unknown,
  messages: ChatMsg[],
): Promise<{ text: string; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "Ти — особистий фінансовий радник у застосунку Money Track. Відповідай українською, по-людськи, по суті. " +
        "Коли питання просте — стисло; коли складне чи користувач просить розібратись/порадити — відповідай ДЕТАЛЬНО й " +
        "структуровано (короткий висновок → пояснення на його числах → 2-4 конкретні дієві кроки з ефектом у грн). " +
        "⚠️ ПЕРІОДИ (критично, щоб не вводити в оману): у контексті period_note пояснює, що monthly_burn_uah — це вже " +
        "СЕРЕДНЄ НА МІСЯЦЬ, а суми top_categories/by_event подано і за 90 днів (spent_90d_uah), і на місяць (avg_month_uah). " +
        "Порівнюючи з доходом чи burn — бери avg_month_uah; НЕ називай 90-денну суму місячною витратою. " +
        "Можна markdown: **жирний** для акцентів, списки з «- », підзаголовки. " +
        "Ось контекст фінансів користувача (суми в грн): " + JSON.stringify(context) +
        ". Якщо в контексті є transactions:[{id,label}] і доречно послатися на конкретну операцію — цитуй її як " +
        "[tx:ID|короткий підпис] (напр. [tx:abc|MrGrill 150₴]); застосунок перетворить це на клікабельний чип. " +
        "Коли доречно ПОРІВНЯТИ кілька чисел (розподіл по категоріях, топ витрат тощо) — намалюй міні-графік " +
        "блоком: рядок «[chart:Заголовок]», далі по рядку «Підпис|число» (число у грн, без символів), і закрий «[/chart]». " +
        "Приклад: [chart:Витрати по категоріях]\\nПродукти|4500\\nКафе|3200\\n[/chart]. Використовуй лише реальні числа з контексту, максимум 6 рядків. " +
        "Спирайся лише на подані дані; якщо потрібної інформації нема — скажи чесно, не вигадуй транзакцій чи чисел.",
    },
  ];
  // §R6: детальніші відповіді порадника (Sonnet 5) — більший ліміт виводу.
  const { text, usage } = await callHaikuMessages(env, system, messages, 1300, await getTaskModel(env, "chat"));
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
    const retry: ChatMsg[] = [...messages, { role: "user", content: "Поверни ЛИШЕ валідний JSON-обʼєкт, без тексту до/після." }];
    const second = await callHaikuMessages(env, system, retry, maxTokens, model);
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
      "враховуй їх: якщо користувач уже пояснив, що це, спирайся на це, а не ігноруй.",
  );
  const system: AnthropicContentBlock[] = [
    ...base,
    { type: "text", text: "Контекст операції (суми в її валюті): " + JSON.stringify(ctx) },
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

function parseJson<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const extracted = extractBalanced(cleaned);
    if (extracted) return JSON.parse(extracted) as T;
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
): Promise<{ result: T; usage: AnthropicUsage }> {
  const first = await callHaiku(env, system, userContent, maxTokens, model);
  try {
    return { result: parseJson<T>(first.text), usage: first.usage };
  } catch {
    const retryContent = [
      ...userContent,
      { type: "text", text: "Твоя попередня відповідь була невалідним JSON. Поверни ЛИШЕ валідний JSON-обʼєкт, без жодного тексту, пояснень чи markdown до або після." },
    ];
    const second = await callHaiku(env, system, retryContent, maxTokens, model);
    return { result: parseJson<T>(second.text), usage: second.usage };
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
      "{clean_name (людська назва), category_id (id основної категорії або null), " +
      "kind ('expense'|'income'|'transfer'|'withdrawal'; transfer=переказ між своїми рахунками/округлення, " +
      "withdrawal=зняття готівки), tag_ids (масив 0-3 id вторинних категорій), note (короткий здогад або null)}. " +
      "ПРІОРИТЕТ №1 — user_note: якщо користувач прямо написав, що це (напр. «це відпочинок», «подарунок», " +
      "«це Розваги»), став саме ту категорію, яку він має на увазі (враховуй синоніми: відпочинок/дозвілля→Розваги, " +
      "їжа→Продукти тощо). ПРІОРИТЕТ №2 — current_category: якщо користувач уже вручну обрав категорію, НЕ перетирай " +
      "її на «Інше» без вагомих підстав із полів; лишай як є або уточнюй у її межах. " +
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
  return callHaikuJson<EnrichResult>(env, system, [
    { type: "text", text: `Проаналізуй транзакцію і поверни лише JSON:\n${JSON.stringify(payload)}` },
  ]);
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
  return callHaikuJson<BudgetPlan>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 1500, await getTaskModel(env, "budget"));
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
        "від подушки. recent_oneoff — разові витрати місяця (податки, лікар): НЕ вважай їх регулярними й не проектуй у майбутнє. " +
        "У payload є citable_operations:[{id,label}] — коли згадуєш конкретну операцію в summary чи suggestions.detail, " +
        "встав після назви токен [tx:ID] з відповідним id (напр. «Rozetka [tx:abc]»). Лише наявні id, не вигадуй, 1-2 доречні. " +
        "Будь конкретним і емпатичним, без води й без markdown. Відповідай ВИКЛЮЧНО валідним JSON: " +
        "{runway_comment, summary, " +
        "facts:[{label, amount (грн число або null), category (назва або null), delta_pct (число або null), tone ('pos'|'neg'|'neutral')}] (2-5 ключових фактів), " +
        "suggestions:[{title, detail, action}]} — 3-5 порад, кожна дієва (що саме скоротити/зробити і ефект у грн). " +
        "action — або null, або {type:'create_budget', label, category_id (з top_categories), category_name, amount_uah} " +
        "коли доречно запропонувати ліміт-конверт на категорію. Суми — у гривнях.",
    },
  ];
  return callHaikuJson<AdviceResult>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 1600, await getTaskModel(env, "advisor"));
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
        "(порожній масив, якщо це просто відповідь без нових пропозицій лімітів)}.",
    },
    { type: "text", text: "Контекст: " + JSON.stringify(ctx) },
  ];
  return callHaikuMessagesJson<BudgetChatResult>(env, system, messages, 900, await getTaskModel(env, "budget"));
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
        "notable та biggest_expenses мають поле tx_id — коли згадуєш КОНКРЕТНУ операцію в тексті (summary/sections/" +
        "anomalies.detail/advice.detail), встав посилання на неї токеном [tx:ID] одразу після назви (напр. «Rozetka [tx:abc123]»), " +
        "де ID — саме tx_id тієї операції. Використовуй ЛИШЕ наявні tx_id, не вигадуй. Не зловживай — 1-2 цитати там, де доречно. " +
        "Пиши по суті, з конкретними числами й % змін. Відповідай ВИКЛЮЧНО валідним JSON без markdown: " +
        "{headline, summary, sections:[{title, body}] (2-4 секції — куди пішли гроші, що змінилось і чому, ризики), " +
        "category_breakdown:[{name, amount_uah, delta_pct (число або null), note}] (топ-8 категорій, note — 1 фраза), " +
        "anomalies:[{label, detail, severity ('info'|'warn'|'high')}] (незвичні/разові витрати, подорожчання підписок; " +
        "порожній масив якщо нема), predictions:{next_period_spend_uah (число або null), runway_months (число або null), " +
        "note}, advice:[{title, detail, action}] (3-5 дієвих порад з ефектом у грн; action — null або " +
        "{type:'create_budget', label, category_id, category_name, amount_uah})}. Суми — цілі числа гривень.",
    },
  ];
  return callHaikuJson<FinancialReport>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 3000, await getTaskModel(env, "report"));
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
        "українською. Враховуй нотатки користувача (user_note) — якщо він пояснив разову витрату, не називай її " +
        "регулярною. Відповідай ВИКЛЮЧНО валідним JSON без markdown: {headline (1 речення — головне за період), " +
        "facts:[{label, amount (грн число або null), category (назва або null), delta_pct (зміна проти минулого " +
        "періоду, число +/- або null), tone ('pos'|'neg'|'neutral')}] (2-5 фактів — куди пішло найбільше, помітні " +
        "зміни, аномалії), note (1 коротка порада або null)}. Суми — у гривнях.",
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
