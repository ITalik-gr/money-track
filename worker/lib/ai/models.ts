// L3 — model routing: which Claude model answers which task.
//
// Provider-specific by nature (these are Anthropic model ids), and the topmost of the three
// provider layers: everything below `json.ts` is provider-agnostic and needs no changes if a
// second provider is ever added. See ARCHITECTURE.md §3 D3 for the layer table.
import type { Env } from "../../env.ts";
import { getState } from "../finance/repo.ts";
import { isDemoEnv } from "../platform/demo.ts";

// Гібрид (рішення користувача 2026-07-06): масові/фонові задачі — дешевий Haiku;
// розумні user-facing (чат по операції, поради, розуміння підписок, рев'ю) — Sonnet.
// Generation 5.5 since 2026-11-06. Each of the three needs a different "no thinking" shape —
// see `thinkingParams` below before adding or swapping a model here.
export const MODEL_FAST = "claude-haiku-5-5";
export const MODEL_SMART = "claude-sonnet-5-5";
export const MODEL_OPUS = "claude-opus-5-5";
// Every 5.5 model runs adaptive thinking when `thinking` is omitted — for our light JSON/chat calls
// that is latency and cost with nothing to show for it, so it is turned off. The 5.5 generation
// made "off" a per-model shape, and the wrong one is a 400, not a slower answer:
//  • Haiku 5.5 — `disabled` is accepted at effort ≤ high (its default is medium).
//  • Sonnet 5.5 — `disabled` is a 400; `between_tools` is the off switch (alone, effort ≤ high).
//  • Opus 5.5 — thinking cannot be turned off at all; `low` effort is the nearest equivalent.
//    Its thinking blocks then come back in tool turns, which is why `readStream` in ai.ts rebuilds them.
export function thinkingParams(model: string): Record<string, unknown> {
  if (model === MODEL_FAST) return { thinking: { type: "disabled" } };
  if (model === MODEL_SMART) return { thinking: { type: "between_tools" } };
  if (model === MODEL_OPUS) return { output_config: { effort: "low" } };
  return {};
}

// Not a Claude model: TypeSafe's judgment model (docs/JEV.md). It lives in this table only so
// `cost.ts` can price it; nothing routes a TASK to it through `getTaskModel`.
export const JEV_MODEL = "jev-latest";

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
