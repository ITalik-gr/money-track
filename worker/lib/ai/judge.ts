// TRANSPORT for judgments — the only file that POSTs to TypeSafe (docs/JEV.md §6).
//
// A sibling of `ai.ts`, not a layer beneath it, and deliberately NOT behind the `json.ts` provider
// seam: that seam is for providers that COMPLETE text into JSON. Jev does not complete anything —
// it takes `state` plus a map of typed questions and returns a typed answer per question with a
// probability. Squeezing that through a "give me JSON" interface would throw away the one thing
// that makes it worth calling (the distribution), so it gets its own, much smaller, transport.
//
// Who may reach it is decided here too, for the same reason `demoClamp` lives in `ai.ts`: a guard
// every future call site has to remember is not a guard.
import type { Env } from "../../env.ts";
import { isDemoEnv } from "../platform/demo.ts";
import { recordUsage } from "./cost.ts";
import { JEV_MODEL } from "./models.ts";

const API = "https://api.typesafe.ai/v1/systemone";

/** Anything the API accepts as instructions or a criterion: a string, or structure that clarifies it. */
export type Rubric = string | Record<string, unknown> | unknown[];

export type JudgeQuestion =
  | { type: "choice"; instructions: Rubric; criteria: Record<string, Rubric | null> }
  | { type: "noul"; instructions: Rubric; criteria?: { true?: Rubric; false?: Rubric } }
  | { type: "score"; instructions: Rubric; criteria: Rubric[] };

export type JudgeAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export interface JudgeUsage { input_tokens: number; output_tokens: number }

/**
 * Whether judgments are available on THIS request.
 *
 * Owner-only because `JEV_API_KEY` is the OWNER's key (`docs/JEV.md §10`, decided 2026-09-21): a deployment-wide
 * secret, and a deployment-wide secret applied to every user is exactly the defect `UserDO`'s
 * `userCredentials` was fixed for (strangers' ledgers billed to — and sent under — the owner's
 * account). A demo never reaches it at all: `demo.ts` caps spend in Anthropic dollars and knows
 * nothing about a second provider, so an uncapped path is simply closed.
 */
export function judgeAvailable(env: Env): boolean {
  return !!env.JEV_API_KEY && !!env.IS_OWNER && !isDemoEnv(env);
}

/**
 * Whether THIS request should ask Jev at all: the switch is on (`AI_JUDGE`) AND the judge is
 * available to this user. Every call site asks this one function, so turning Jev off is one var.
 */
export function judgeOn(env: Env): boolean {
  return env.AI_JUDGE === "jev" && judgeAvailable(env);
}

/**
 * Ask a set of independent questions about one state, in ONE request.
 *
 * They are evaluated in parallel and cannot see each other's answers — which is the point: a
 * dozen judgments about a transaction for roughly the latency of one. A question whose options
 * depend on another's answer needs a second call, and that is the caller's decision, not this one's.
 *
 * Throws on a non-2xx or on a missing answer: the caller falls back to the Haiku ladder rather
 * than filing a row on half a verdict (docs/JEV.md §10 — the webhook must degrade, not go blind).
 */
export async function judge<K extends string>(
  env: Env,
  state: unknown,
  questions: Record<K, JudgeQuestion>,
): Promise<{ answers: Record<K, JudgeAnswer>; usage: JudgeUsage }> {
  if (!judgeAvailable(env)) throw new Error("JEV_API_KEY not set");
  const res = await fetch(API, {
    method: "POST",
    headers: { authorization: `Bearer ${env.JEV_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
  });
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { answers?: Record<string, JudgeAnswer>; usage?: JudgeUsage };
  const answers = body.answers ?? {};
  for (const k of Object.keys(questions)) {
    if (!answers[k]) throw new Error(`TypeSafe: no answer for "${k}"`);
  }
  const usage = { input_tokens: body.usage?.input_tokens ?? 0, output_tokens: body.usage?.output_tokens ?? 0 };
  // Same counter as every Anthropic call, so «💸 Витрати на AI» stays the whole bill. The price
  // basis differs (input only), and `cost.ts` carries that as its own row rather than a special case.
  await recordUsage(env, JEV_MODEL, usage);
  return { answers: answers as Record<K, JudgeAnswer>, usage };
}
