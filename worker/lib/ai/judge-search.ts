// docs/JEV.md phase 4 — §SEARCH-VEC rerank: «is this the operation the person is looking for?»
//
// ⛔ NOT WIRED INTO SEARCH (2026-09-21). Measured on `sites.json` (§7.4) it scored 80%, and the
// failures were the wrong kind: «Фора» at 0.59 for a bicycle-parts query, the bicycle workshop at
// 0.46 — no threshold separates them, so it would both hide the answer and show noise. Search keeps
// its cosine floor. This file stays because `scripts/eval-sites.mjs` measures it: a newer Jev is
// re-measured with one command, and it is wired in only when a line separates the two sides.
//
// A vector index always returns its nearest neighbours, however far they are, so semantic search
// had one hand-tuned cosine floor (`minScore = 0.45`) whose only validation was a live test by hand
// (NIGHT.md §0.4). A cosine score measures «these texts are about similar things»; the question is
// «is this THE thing». Rozetka and a phone-repair shop are close in embedding space and far apart to
// someone looking for their repair bill.
//
// So the floor is lowered (the index proposes more), and a judgment decides what is shown: ONE
// request with one Noul per candidate — they are independent, so they run together for the latency
// of one. The §SEARCH-VEC rule is untouched: this only ever filters the SEMANTIC extras; exact
// matches never reach it and keep their place and order.
import type { Env } from "../../env.ts";
import { judge, judgeOn, type JudgeQuestion } from "./judge.ts";

/** Measured on `sites.json` (§7.4). */
export const RELEVANT_AT = 0.5;

/** How loose the index may be when a judge is there to filter behind it. */
export const JUDGED_MIN_SCORE = 0.3;

export interface SearchCandidate { id: string; text: string }

/**
 * The ids worth showing, in their original order — or null when Jev is off or failed, in which
 * case the caller keeps the cosine floor. Never throws: search must not break because a judge did.
 */
export async function judgeRelevant(env: Env, query: string, cands: SearchCandidate[]): Promise<string[] | null> {
  if (!judgeOn(env) || !cands.length) return null;
  try {
    const questions: Record<string, JudgeQuestion> = {};
    cands.forEach((c, i) => {
      questions[`c${i}`] = {
        type: "noul",
        instructions: { operation: c.text, question: "Is `operation` what the person is looking for with `query` — or at least a plausible match worth showing them?" },
        criteria: {
          true: "It is the kind of operation the query describes",
          false: "It is merely about a similar topic, or unrelated",
        },
      };
    });
    const { answers } = await judge(env, { query }, questions);
    return cands.filter((_, i) => {
      const a = answers[`c${i}`];
      return a?.type === "noul" && a.noul >= RELEVANT_AT;
    }).map((c) => c.id);
  } catch (e) {
    console.warn(`[jev] search rerank fell back to the cosine floor: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
