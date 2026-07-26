// Demo AI spend limiter (P4.3, PLATFORM.md §11.3).
//
// The demo runs on OUR Anthropic key, so an open "generate" button is an open wallet. Three
// layers cap it, cheapest check first:
//   1. per-session  — a counter in the demo object's own app_state (one sandbox = ~one visitor);
//   2. global daily — an atomic counter in the shared directory db; this is the one that actually
//      saves us, because "many sessions × a small per-session limit" still sums to infinity;
//   3. (outside this file) the model is forced to Haiku and the key is a dedicated
//      `DEMO_ANTHROPIC_KEY` with its own billing limit on Anthropic's side — the last backstop.
//
// A hit throws `DemoAiLimitError`, whose message is shown to the user as-is (via `errText`): the
// point is an honest "the demo's shared AI budget is used up, the examples you see are real"
// rather than a silent failure.
import type { Env } from "../env.ts";

export const DEMO_SESSION_AI_CAP = 12;      // per sandbox
export const DEMO_GLOBAL_DAILY_AI_CAP = 300; // across ALL sandboxes, per day

export function isDemoEnv(env: Env): boolean {
  return (env.USER_ID ?? "").startsWith("demo:");
}

export class DemoAiLimitError extends Error {
  constructor(scope: "session" | "global") {
    super(
      scope === "session"
        ? "You've reached this demo sandbox's AI limit. The advisor, reports and insights already on screen are real, pre-generated examples — explore those."
        : "The demo's shared daily AI budget is used up for today. Everything already on screen (advisor, reports, the feed) is a real, pre-generated example — please explore those.",
    );
    this.name = "DemoAiLimitError";
  }
}

/**
 * Gate one Anthropic call for a demo session. No-op for real users. Throws before spending if a
 * cap is hit. Called at every fetch to Anthropic, so a 6-turn tool conversation counts as 6 — a
 * conservative accounting that errs toward protecting the budget.
 */
export async function demoAiGate(env: Env): Promise<void> {
  if (!isDemoEnv(env)) return;
  const { getState, setState } = await import("./repo.ts");

  // Session cap first — local, no external write, no race (a DO is single-threaded).
  const sessionN = Number((await getState(env.DB, "demo_ai_count")) ?? "0") + 1;
  await setState(env.DB, "demo_ai_count", String(sessionN));
  if (sessionN > DEMO_SESSION_AI_CAP) throw new DemoAiLimitError("session");

  // Global cap — atomic increment in the shared directory db. `RETURNING` gives THIS call's count
  // in one statement, so concurrent sandboxes can't both slip past the ceiling. If the table
  // isn't there yet, fall back to session-cap-only rather than failing the call.
  const day = new Date().toISOString().slice(0, 10);
  const key = `demo_ai_${day}`;
  try {
    const row = await env.DIRECTORY
      .prepare(
        `INSERT INTO shared_state (key, value, updated_at) VALUES (?, '1', ?)
         ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1, updated_at = excluded.updated_at
         RETURNING value`,
      )
      .bind(key, Math.floor(Date.now() / 1000))
      .first<{ value: string }>();
    if (Number(row?.value ?? "0") > DEMO_GLOBAL_DAILY_AI_CAP) throw new DemoAiLimitError("global");
  } catch (e) {
    if (e instanceof DemoAiLimitError) throw e;
    // shared_state missing / directory not migrated — session cap already applied above.
  }
}
