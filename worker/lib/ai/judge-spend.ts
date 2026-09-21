// docs/JEV.md phase 4 — «what did this money actually go on?» for a TRANSFER or a cash withdrawal
// (§F2 step 2), and the nightly catch-up over rows the app failed to file (§AI-CATCHUP).
//
// Both are the same judgment over the same options as enrich's root question, so both reuse
// `options`/`criterion` from `judge-tx.ts` — one guide, one list of categories, whichever caller
// asks. A second list here would be the phase-1 mistake again (docs/JEV.md §7.2).
//
// The confidence line is the CASCADE line: below `ROOT_CASCADE_AT` Jev does not answer, and each
// caller decides what «no answer» means — §F2 asks Claude, the catch-up leaves the gap (its whole
// rule is «a gap the person can see beats a wrong category filed silently»).
import type { Env } from "../../env.ts";
import { judge, judgeOn, type JudgeQuestion } from "./judge.ts";
import { options, judgeTransaction, ROOT_CASCADE_AT } from "./judge-tx.ts";
import { TRANSFER_CAT } from "./enrich.ts";

/** The option that means «this was the user's own money moving — there is no real category». */
const OWN_MONEY = "Own money moving";

export interface SpendJudgment {
  /** The real category, or null when it was the user's own money moving. */
  category_id: number | null;
  /** The probability of the chosen option — the caller's «high / low» and cascade line. */
  p: number;
}

/**
 * The real category behind a transfer or a withdrawal, or null when Jev is off or failed.
 *
 * Options are the EXPENSE roots minus the transfer bucket itself (answering «Transfers» to «what
 * was this transfer for» fills nothing — the same rule `catchup.ts` enforces on Claude's answer),
 * plus one explicit «own money» option: a transfer between the person's own accounts has no real
 * category, and without the option Jev would be forced to invent one.
 */
export async function judgeRealCategory(
  env: Env,
  tx: { merchant: string | null; comment: string | null; mcc: number | null; amount: number; currency_code: number; history?: string | null; hint?: string | null },
): Promise<SpendJudgment | null> {
  if (!judgeOn(env)) return null;
  try {
    const { roots } = await options(env, false);
    const criteria: Record<string, unknown> = {};
    const ids = new Map<string, number>();
    for (const [k, v] of roots) {
      if (v.id === TRANSFER_CAT) continue;
      criteria[k] = v.guide;
      ids.set(k, v.id);
    }
    criteria[OWN_MONEY] = "A transfer between the person's own cards, accounts, jars or savings, a round-up, or cash taken out with nothing saying what it was for";
    const question: JudgeQuestion = {
      type: "choice",
      instructions: {
        question: "This operation is a transfer to a person or a cash withdrawal. What was the money actually spent on?",
        rules: [
          "If `user_hint` or `bank_comment` says what it was for, that decides it.",
          "If `merchant_history` shows how the user classified this before, agree with it.",
        ],
      },
      criteria: criteria as Record<string, string | null>,
    };
    const { answers } = await judge(env, {
      user_hint: tx.hint?.trim() || null,
      raw_description: tx.merchant,
      bank_comment: tx.comment,
      mcc: tx.mcc,
      amount: tx.amount / 100,   // plausibility only, never arithmetic (docs/JEV.md §2)
      currency_code: tx.currency_code,
      merchant_history: tx.history ?? null,
    }, { real: question });
    const a = answers.real;
    if (a.type !== "choice") throw new Error("answer of the wrong type");
    return { category_id: a.choice === OWN_MONEY ? null : ids.get(a.choice) ?? null, p: a.probabilities[a.choice] ?? 0 };
  } catch (e) {
    console.warn(`[jev] real-category fell back: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * §AI-CATCHUP with Jev: one judgment per row, and null (a gap) whenever Jev is below its line.
 *
 * A category-less row is asked exactly what enrich asks (`judgeTransaction` — root, leaf, cascade),
 * so the nightly pass and the webhook cannot disagree about the same operation. A bucket-13 row is
 * asked the §F2 question. Returns null for the whole batch when Jev is off, so the caller keeps
 * its one Claude call.
 */
export async function judgeCatchup(
  env: Env,
  rows: { id: string; is_transfer_bucket: number; merchant: string | null; comment: string | null; mcc: number | null; amount: number; currency_code: number; text: string }[],
): Promise<{ id: string; category_id: number | null }[] | null> {
  if (!judgeOn(env)) return null;
  const out = await Promise.all(rows.map(async (r) => {
    if (r.is_transfer_bucket) {
      const j = await judgeRealCategory(env, { ...r, merchant: r.text });
      return { id: r.id, category_id: j && j.p >= ROOT_CASCADE_AT ? j.category_id : null };
    }
    const j = await judgeTransaction(env, {
      merchant: r.text, comment: r.comment, mcc: r.mcc, amount: r.amount, currency_code: r.currency_code,
    });
    return { id: r.id, category_id: j?.result.category_id ?? null };
  }));
  return out;
}

