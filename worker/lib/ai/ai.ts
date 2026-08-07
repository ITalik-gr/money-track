// L1 — TRANSPORT. The only file that POSTs to Anthropic.
//
// This file used to be 1 335 lines carrying six unrelated jobs (ARCHITECTURE.md §3 D3): the
// transport, the price list, model routing, JSON repair, the prompts, AND the feature logic for
// every AI-backed screen. `generateFinancialReport` lived here while `report.ts` already existed
// as its own 330-line file — with no rule deciding which of the two a feature belonged in, it
// ended up in both, and the next person appended to whichever they happened to have open.
//
// It is now transport only, and the layers below it are:
//   `models.ts`  L3 — which model answers which task     (Anthropic-specific)
//   `cost.ts`    L2 — what a call cost, and the running total (Anthropic-specific)
//   `json.ts`    L4 — getting valid JSON back            ← THE PROVIDER SEAM IS HERE
//   `prompt.ts`  L5 — the stable prefix and the language directive
//   `tasks.ts`   L6 — the conversational calls with no feature file of their own
// and the feature calls sit with their features (`report.ts`, `insight.ts`, `enrich.ts`,
// `receipt.ts`). Everything from `json.ts` upwards is provider-agnostic.
//
// NOTE (§6.7): Haiku's minimum cacheable prefix is 4 096 tokens, so `cache_control` on a small
// prefix silently does nothing — see `prompt.ts`, which owns that decision now.
import type { Env } from "../../env.ts";
import { demoAiGate, isDemoEnv } from "../platform/demo.ts";
import { MODEL_FAST } from "./models.ts";
import { recordUsage, type AnthropicUsage } from "./cost.ts";

const API = "https://api.anthropic.com/v1/messages";


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

export interface AnthropicContentBlock {
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



/**
 * Called with every text fragment as it arrives. Passing one switches a request to streaming.
 *
 * WHY STREAMING EXISTS HERE AND NOWHERE ELSE (2026-08-07): an agentic chat answer takes tens of
 * seconds, and until now the user watched a spinner for all of them — the app looked hung next to
 * every other AI product, which show the first words in about a second. Nothing about the ANSWER
 * changes; only when the reader starts seeing it. That is why it is a callback rather than a new
 * code path: the accumulated result, the usage accounting and `demoClamp` stay exactly as they are.
 */
export type OnText = (chunk: string) => void;

/**
 * Read Anthropic's SSE stream into the same shape a non-streamed response has.
 *
 * The reconstruction is the point: everything above the transport — the tool loop, the JSON
 * repair, the cost counter — keeps working on `{content, usage, stop}` and never learns that the
 * bytes arrived in pieces. Two block types have to be rebuilt from deltas: text (`text_delta`) and
 * tool input (`input_json_delta`, whose fragments are a JSON string split at arbitrary points, so
 * they can only be concatenated and parsed at the end).
 */
async function readStream(
  res: Response,
  onText?: OnText,
): Promise<{ content: RawBlock[]; usage: AnthropicUsage; stop: string | null }> {
  const blocks: RawBlock[] = [];
  const partialJson: string[] = [];
  const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  let stop: string | null = null;

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; a chunk can split one anywhere, so only whole
    // frames are consumed and the remainder stays in the buffer.
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>; } catch { continue; }

      switch (ev.type) {
        case "message_start": {
          const u = (ev.message as { usage?: AnthropicUsage } | undefined)?.usage;
          if (u) Object.assign(usage, u);
          break;
        }
        case "content_block_start": {
          const i = ev.index as number;
          blocks[i] = { ...(ev.content_block as RawBlock) };
          partialJson[i] = "";
          break;
        }
        case "content_block_delta": {
          const i = ev.index as number;
          const d = ev.delta as { type?: string; text?: string; partial_json?: string };
          if (d.type === "text_delta" && d.text) {
            blocks[i] = { ...blocks[i], type: "text", text: (blocks[i]?.text ?? "") + d.text };
            onText?.(d.text);
          } else if (d.type === "input_json_delta" && d.partial_json != null) {
            partialJson[i] = (partialJson[i] ?? "") + d.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const i = ev.index as number;
          if (partialJson[i]) {
            try { blocks[i] = { ...blocks[i], input: JSON.parse(partialJson[i]) as Record<string, unknown> }; }
            catch { /* a tool call we cannot parse is one the loop will report as failed */ }
          }
          break;
        }
        case "message_delta": {
          stop = (ev.delta as { stop_reason?: string | null } | undefined)?.stop_reason ?? stop;
          // Output tokens are only final here — `message_start` reports the input side.
          const u = ev.usage as Partial<AnthropicUsage> | undefined;
          if (u?.output_tokens != null) usage.output_tokens = u.output_tokens;
          break;
        }
        case "error":
          throw new Error(`anthropic stream: ${JSON.stringify(ev.error)}`);
      }
    }
  }
  return { content: blocks.filter(Boolean), usage, stop };
}

export async function callHaiku(
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

export async function callHaikuMessages(
  env: Env,
  system: AnthropicContentBlock[],
  messages: ChatMsg[],
  maxTokensIn = 700,
  modelIn: string = MODEL_FAST,
  onText?: OnText,
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
    body: JSON.stringify({
      model, max_tokens: maxTokens, ...thinkingOff(model), system, messages,
      ...(onText ? { stream: true } : {}),
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  if (onText) {
    const s = await readStream(res, onText);
    const text = s.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    await recordUsage(env, model, s.usage);
    return { text, usage: s.usage, stop: s.stop, capped };
  }
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

export async function callMessagesRaw(
  env: Env,
  system: AnthropicContentBlock[],
  messages: RawMsg[],
  maxTokensIn: number,
  modelIn: string,
  toolsIn?: unknown[], // client-side ChatTool[] та/або серверні блоки (web_search)
  onText?: OnText,
): Promise<{ content: RawBlock[]; usage: AnthropicUsage; stop: string | null }> {
  await demoAiGate(env); // P4.3: cap/deny Anthropic spend for demo sandboxes (no-op for real users)
  const { model, maxTokens, tools } = demoClamp(env, { model: modelIn, maxTokens: maxTokensIn, tools: toolsIn });
  const res = await fetch(API, {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: maxTokens, ...thinkingOff(model), system, messages,
      ...(tools?.length ? { tools } : {}),
      ...(onText ? { stream: true } : {}),
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  if (onText) {
    const s = await readStream(res, onText);
    await recordUsage(env, model, s.usage);
    return s;
  }
  const data = (await res.json()) as { content: RawBlock[]; usage: AnthropicUsage; stop_reason?: string | null };
  await recordUsage(env, model, data.usage); // §Хвіст C: кожен виклик (вкл. tool-turns) у лічильник
  return { content: data.content ?? [], usage: data.usage, stop: data.stop_reason ?? null };
}

// Веде діалог з інструментами до фінальної текстової відповіді (кеп ходів — межа вартості).
export async function runToolConversation(
  env: Env,
  system: AnthropicContentBlock[],
  initial: ChatMsg[],
  tools: ChatTool[],
  executor: ToolExecutor,
  maxTokens: number,
  model: string,
  maxTurns = 6,
  serverTools: unknown[] = [], // §A3: серверні tools (web_search) — виконуються на боці Anthropic
  // Streamed to the reader as it is produced. EVERY turn streams, not just the last one: which
  // turn is final is only known after it answers, so waiting to find out would put the whole
  // point of streaming behind the delay it exists to remove. Tool turns emit little or no text,
  // so in practice the reader sees the answer turn.
  onText?: OnText,
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
    const { content, usage, stop } = await callMessagesRaw(env, system, messages, maxTokens, model, reqTools, onText);
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
  const final = await callMessagesRaw(env, system, messages, maxTokens, model, serverTools.length ? serverTools : undefined, onText);
  add(final.usage);
  return { text: textOf(final.content), usage: total };
}

