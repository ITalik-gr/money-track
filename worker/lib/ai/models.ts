// L3 — model routing: which Claude model answers which task.
//
// Provider-specific by nature (these are Anthropic model ids), and the topmost of the three
// provider layers: everything below `json.ts` is provider-agnostic and needs no changes if a
// second provider is ever added. See ARCHITECTURE.md §3 D3 for the layer table.
import type { Env } from "../../env.ts";
import { getState } from "../finance/repo.ts";
import { isDemoEnv } from "../platform/demo.ts";

// Гібрид (рішення користувача 2026-07-06): масові/фонові задачі — дешевий Haiku;
// розумні user-facing (чат по операції, поради, розуміння підписок, рев'ю) — Sonnet 5.
export const MODEL_FAST = "claude-haiku-4-5";
export const MODEL_SMART = "claude-sonnet-5";
export const MODEL_OPUS = "claude-opus-4-8";

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
