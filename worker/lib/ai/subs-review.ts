/**
 * §SUB-REVIEW (2026-09-02) — the model as a JUDGE over the candidate list, not as a third detector.
 *
 * WHY THIS AND NOT A THIRD DETECTOR. Two mechanisms already answer "is this a subscription" from
 * opposite ends: §SUB-DETECT reads a RHYTHM out of the history, and §AI-RECURRING asks about a
 * single charge on the day it lands, while the person still remembers signing up. A third
 * mechanism producing its own candidates would be §CUR-PLAN written again — a third definition of
 * one number, disagreeing with the other two where nobody looks.
 *
 * What was actually wrong is not coverage, it is PRECISION AND RECALL AT THE EDGE, and both edges
 * are named in `lib/finance/recurring.ts` as costs the thresholds knowingly pay:
 *
 *   • the list carries shops that passed the rhythm test by coincidence — and a proposal the user
 *     has to dismiss costs more trust than one never made, which is why they stop reading the
 *     block at all;
 *   • it MISSES a real subscription whose price rose mid-window (the bucket splits and drops under
 *     `BUCKET_DOMINANCE`) or whose charges are ragged (a retry, or earlier months already linked
 *     to a plan and therefore absent).
 *
 * Both are judgement calls about a merchant NAME, which is the one thing arithmetic cannot read
 * and a model can. So the model does exactly that and nothing else: it looks at rows the
 * deterministic pass has already grouped, and says bill / not / unsure.
 *
 * ⚠️ **The verdict is stored, never computed live.** `/planned/detect` is a GET the Subscriptions
 * page issues on every open; a call in that path would be paid for per page view and would make
 * the list arrive seconds late, to answer a question whose answer does not change between two page
 * loads. The daily pass decides; the endpoint reads (migration 0049).
 *
 * ⚠️ **ONE call per BATCH, never per merchant** — the same rule as §AI-CATCHUP, for the same
 * reason: an account whose merchants are all already judged must pay nothing at all, and the check
 * that establishes that is one indexed read.
 *
 * ⚠️ **A `not` verdict HIDES nothing.** The row travels to the screen with its reason and is filed
 * under a collapsed «AI відхилив». A silent filter is a filter nobody can correct: a false
 * positive the model removes is visible as a row that stopped appearing, but a real subscription
 * it removes is invisible in every surface the app has — which is the failure this whole feature
 * exists to fix, reintroduced one layer up.
 *
 * ⚠️ **The user always outranks the model.** A merchant the person dismissed (§R5) never reaches
 * here, and a plan they declared removes the candidate before review. The model judges only what
 * the person has not yet answered for.
 */
import type { Env } from "../../env.ts";
import { callHaikuJson } from "./json.ts";
import { buildSystemPrefix, replyLangDirective } from "./prompt.ts";
import { MODEL_FAST } from "./models.ts";
import { logUsage } from "./cost.ts";
import { coreToken } from "../finance/merchants.ts";
import { recurringCandidates, nearMissCandidates } from "../finance/recurring.ts";
import * as planningRepo from "../../repo/planning.ts";
import type { RecurringCandidate } from "../../../shared/api/planning.ts";
import type { SubReviewRow } from "../../repo/planning.ts";

/** How many merchants one pass may judge. Beyond this the rest waits for tomorrow. */
const BATCH = 25;

/** The detection window, kept identical to `/planned/detect` — the pass must judge the SAME list
 *  the screen shows, or it decides about rows nobody is being offered. */
const WINDOW_DAYS = 400;

/**
 * How long an `unsure` stands before it is asked again.
 *
 * A definite verdict is never re-asked: the merchant has not changed what it is, and re-deciding
 * it nightly would be paying for the same sentence forever. `unsure` is different — it usually
 * means too few charges to tell, and that is a state the next month resolves on its own.
 */
const UNSURE_TTL_DAYS = 30;

export type Verdict = "subscription" | "not" | "unsure";

interface ModelVerdict { merchant?: string; verdict?: string; reason?: string }
interface ReviewAnswer { results?: ModelVerdict[] }

/** `coreToken` is the ONE answer to "is this the same merchant" — the same key §SUB-DETECT groups
 *  by, so a verdict can never describe a different grouping than the one on screen. */
export const reviewKey = (merchant: string): string => (coreToken(merchant) ?? "").toLowerCase();

const isVerdict = (v: unknown): v is Verdict =>
  v === "subscription" || v === "not" || v === "unsure";

/**
 * The candidate list, exactly as the endpoint builds it, minus what the user has answered for.
 *
 * Deterministic rows AND near-misses, because the pass has two jobs at once and they are the same
 * question: weed the list, and let back in what one threshold wrongly excluded.
 */
export async function reviewableCandidates(env: Env, now: number): Promise<RecurringCandidate[]> {
  const [charges, declared, dismissed] = await Promise.all([
    planningRepo.detectCharges(env.DB, now - WINDOW_DAYS * 86400),
    planningRepo.declaredPlans(env.DB),
    planningRepo.dismissedMerchants(env.DB),
  ]);
  const { planNeedles, planMatches } = await import("../finance/subscriptions.ts");

  // ⚠️ §SUB-ALIAS: a declared plan is known by EVERY one of its names. Judging a merchant the user
  // already has a plan for would spend a model call to answer a question they answered themselves.
  return [...recurringCandidates(charges, now), ...nearMissCandidates(charges, now)]
    .filter((r) => !declared.some((p) => planMatches(p, r.merchant)
      || planNeedles(p).some((n) => n.toLowerCase() === r.merchant.toLowerCase())))
    .filter((r) => !dismissed.has(r.merchant.toLowerCase()));
}

/** Which of them still need an answer. Separated so the caller can skip the pass for free. */
export function needingReview(
  candidates: RecurringCandidate[],
  stored: Map<string, SubReviewRow>,
  now: number,
): RecurringCandidate[] {
  const stale = now - UNSURE_TTL_DAYS * 86400;
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = reviewKey(c.merchant);
    if (!key || seen.has(key)) return false;   // one merchant, one question, even in two buckets
    const prev = stored.get(key);
    if (prev && !(prev.verdict === "unsure" && prev.decided_at < stale)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Ask once, about all of them.
 *
 * The payload is the EVIDENCE the deterministic pass measured, not the raw charges: how many
 * times, over how many months, on what rhythm, and — for a near-miss — which gate it failed. That
 * is what makes the answer checkable. Handing over the charge rows instead would invite the model
 * to re-derive a rhythm that `chargeRhythm` already defines, which is how a fourth definition of
 * "how often" gets born.
 */
async function askBatch(env: Env, rows: RecurringCandidate[]): Promise<ModelVerdict[]> {
  const system = await buildSystemPrefix(
    env,
    "you are reviewing a list of merchants that a rule-based detector thinks MIGHT be recurring " +
      "bills the user never declared (a subscription, a utility, an instalment, an insurance " +
      "premium, a rent). For EACH merchant answer whether it really is one. " +
      "The decisive question is what the merchant IS, which the numbers cannot say: a grocery " +
      "shop, a café, a taxi or a marketplace visited on a regular schedule is NOT a bill, however " +
      "regular it looks; a streaming service, a cloud or software vendor, a mobile operator, a gym, " +
      "an insurer, a landlord or a utility IS one, even when the amount moves. " +
      // The near-miss half. Without naming it the model treats the flag as a warning and rejects
      // exactly the rows the pass exists to recover.
      "`near_miss` marks a merchant the detector EXCLUDED and is asking you to reconsider: " +
      "`shop` means its charges came at several different prices (which is normal for a bill whose " +
      "price rose mid-year, and normal for a shop too — the name decides), `ragged` means the gaps " +
      "between charges are uneven (a failed payment retried, or earlier charges already linked " +
      "elsewhere). Judge these by the same standard, not more harshly. " +
      // Same rule as §AI-CATCHUP, same reason: a confident wrong answer here is invisible.
      "ANSWER \"unsure\" WHENEVER THE NAME DOES NOT TELL YOU. You are not being scored on how many " +
      "you decide, and an unsure row is simply asked again next month once there are more charges. " +
      "`reason` is ONE short clause saying what the merchant is — it is shown to the user next to " +
      "your verdict, so it must be readable, not a restatement of the numbers. " +
      "Return JSON {results: [{merchant, verdict, reason}]} with one entry per merchant, " +
      "`merchant` exactly as given and `verdict` one of \"subscription\", \"not\", \"unsure\"." +
      // §LANG: `reason` is the one field a person reads, so it follows the app's locale. Everything
      // else in this answer is an enum and language-independent.
      await replyLangDirective(env),
    true,   // stable prefix, runs daily — exactly what the 1h cache is for
  );

  const payload = rows.map((c) => ({
    merchant: c.merchant,
    // Whole currency units, per the app-wide rule that a model is never handed minor units
    // (§AI-UNIT) — the field name has to mean what the number is.
    amount: Math.round(c.amount / 100),
    currency_code: c.currency_code,
    charges: c.n,
    months: c.months,
    every_days: c.avg_interval_days,
    near_miss: c.near_miss ?? null,
  }));

  const { result, usage } = await callHaikuJson<ReviewAnswer>(
    env, system,
    [{ type: "text", text: `Merchants:\n${JSON.stringify(payload)}` }],
    2048, MODEL_FAST,
  );
  logUsage("subs-review", usage);
  return result.results ?? [];
}

export interface SubsReviewResult { asked: number; decided: number; unsure: number }

/**
 * One pass. Safe on an account with nothing to judge — three indexed reads and a return.
 */
export async function runSubsReview(env: Env, now = Math.floor(Date.now() / 1000)): Promise<SubsReviewResult> {
  const candidates = await reviewableCandidates(env, now);
  if (!candidates.length) return { asked: 0, decided: 0, unsure: 0 };

  const stored = await planningRepo.subReviewAll(env.DB);
  const todo = needingReview(candidates, stored, now).slice(0, BATCH);
  if (!todo.length) return { asked: 0, decided: 0, unsure: 0 };

  const verdicts = await askBatch(env, todo);
  const byMerchant = new Map(todo.map((c) => [c.merchant.toLowerCase(), c]));

  let decided = 0, unsure = 0;
  for (const v of verdicts) {
    const row = v.merchant ? byMerchant.get(v.merchant.toLowerCase()) : undefined;
    if (!row) continue;                       // a merchant we never asked about
    // An unrecognised verdict is stored as `unsure` rather than dropped: dropping it means the
    // same merchant is asked again tomorrow and every day after, at cost, for a model that has
    // already demonstrated it will answer this way.
    const verdict: Verdict = isVerdict(v.verdict) ? v.verdict : "unsure";
    await planningRepo.saveSubReview(env.DB, {
      merchant_key: reviewKey(row.merchant),
      merchant: row.merchant,
      verdict,
      reason: typeof v.reason === "string" ? v.reason.slice(0, 160) : null,
      amount: row.amount,
      currency_code: row.currency_code ?? null,
      decided_at: now,
    });
    if (verdict === "unsure") unsure++; else decided++;
  }
  return { asked: todo.length, decided, unsure };
}

/**
 * How many merchants are waiting for a verdict — for the caller that wants to skip the pass.
 *
 * Deliberately does the full grouping rather than a COUNT: the candidate list IS the question, and
 * a cheaper proxy (say, "any charges since yesterday") would run the model on nights when nothing
 * new is proposed and skip nights when a rhythm crossed its threshold without a new charge.
 */
export async function subsReviewPending(env: Env, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const candidates = await reviewableCandidates(env, now);
  if (!candidates.length) return 0;
  const stored = await planningRepo.subReviewAll(env.DB);
  return needingReview(candidates, stored, now).length;
}
