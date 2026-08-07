// L4 — getting valid JSON out of a language model.
//
// **This is where the provider seam sits.** Everything above this file (`models.ts`, `cost.ts`,
// the transport in `ai.ts`) is Anthropic-specific; everything from here up is not, and would need
// no changes if a second provider were ever added. See ARCHITECTURE.md §3 D3.
//
// The two hard-won rules encoded here:
//  1. **A `max_tokens` cut-off is an ERROR even when the response still parsed.** `repairTruncatedJson`
//     closes brackets, `JSON.parse` succeeds — and half a report lands in the database with no
//     retry, precisely because it "worked". Repair exists for MALFORMED output, not for silently
//     accepting half an answer.
//  2. **A schema in the prompt is a request, not a contract.** The model returned valid JSON with
//     empty `sections`/`predictions` — an empty screen. `callHaikuJson` takes a `validate`
//     callback that says what is MISSING and re-asks exactly once; a worse second answer does not
//     replace the first.
//
// ⚠️ Neither retry fires when the ENVIRONMENT did the truncating: `demoClamp` caps demo output at
// 900 tokens, so "truncated → ask for more" bought the same answer twice more and burned the
// shared budget. `callHaiku` reports `capped`, and both retries are disabled under it.
import type { Env } from "../../env.ts";
import { callHaiku, callHaikuMessages, type AnthropicContentBlock } from "./ai.ts";
import type { ChatMsg } from "./ai.ts";
import { MODEL_FAST } from "./models.ts";
import type { AnthropicUsage } from "./cost.ts";

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

// Багатоходовий діалог, що очікує JSON-відповідь (для інлайн-чату по транзакції):
// парсимо текст як JSON, при збої — 1 ретрай зі суворою вказівкою.
export async function callHaikuMessagesJson<T>(
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
