// docs/JEV.md phase 4 — §SUB-REVIEW answered by Jev: «is this merchant a bill, or a shop?»
//
// The Claude prompt had to INVENT a third label, `unsure`, and then beg the model to use it
// («ANSWER unsure WHENEVER THE NAME DOES NOT TELL YOU»), because a text model gives a confident
// word either way. Jev returns a probability, so «unsure» stops being a label the model must be
// talked into and becomes what it always meant: the middle of the distribution. The two lines
// that cut it are measured (docs/JEV.md §7.4), not argued.
//
// ONE request per merchant, not one per batch like the Claude path. A Jev question sees the whole
// state, and «irrelevant context degrades answers» is on its own list of limitations (§8): 25
// merchants in one state means every judgment reads 24 that are not about it. Per-merchant
// requests cost the same tokens in total and run in parallel.
import type { Env } from "../../env.ts";
import { judge, judgeOn, type JudgeQuestion } from "./judge.ts";
import { resolveLocale, st, type ServerStringKey } from "../platform/i18n.ts";
import type { RecurringCandidate } from "../../../shared/api/planning.ts";

/**
 * Measured on `sites.json` (docs/JEV.md §7.4): every real bill came back ≥ 0.58 (EasyPay 0.61,
 * Sportlife 0.58) and every shop ≤ 0.39 (Фора), so the lines sit inside that gap with a thin
 * «unsure» band between them. The first guess, 0.7 / 0.3, called five real bills «unsure».
 * ⚠️ The gap is 0.19 wide on 20 merchants — narrow. New merchants go into `sites.json` first.
 */
export const SUB_AT = 0.5;
export const NOT_AT = 0.4;

/** What a merchant IS — the evidence a verdict stands on, and the reason the person is shown. */
const TYPES: Record<string, { key: ServerStringKey; rubric: string }> = {
  streaming: { key: "merchStreaming", rubric: "A video, music or TV streaming service" },
  software: { key: "merchSoftware", rubric: "Software, an app plan, AI tools, hosting, cloud storage, a domain" },
  telecom: { key: "merchTelecom", rubric: "A mobile operator or an internet provider" },
  utility: { key: "merchUtility", rubric: "Electricity, gas, water, a building association fee, or a service people use to pay such bills (iPay, Portmone)" },
  membership: { key: "merchMembership", rubric: "A gym, a pool, a club or a co-working membership" },
  insurance: { key: "merchInsurance", rubric: "An insurer" },
  rent: { key: "merchRent", rubric: "Rent paid to a landlord or an agency" },
  delivery_plan: { key: "merchDeliveryPlan", rubric: "A delivery on a standing plan — drinking water, a meal box, a pet-food subscription" },
  grocery: { key: "merchGrocery", rubric: "A supermarket or grocery shop" },
  cafe: { key: "merchCafe", rubric: "A café, a restaurant, fast food, food delivery from restaurants" },
  transport: { key: "merchTransport", rubric: "A taxi, public transport, fuel, parking" },
  shop: { key: "merchShop", rubric: "A shop or a marketplace selling goods" },
  pharmacy: { key: "merchPharmacy", rubric: "A pharmacy" },
  post: { key: "merchPost", rubric: "A postal or parcel-delivery service" },
  unclear: { key: "merchUnclear", rubric: "The name does not say what the merchant is" },
};

const BILL: JudgeQuestion = {
  type: "noul",
  instructions: {
    question: "Is `merchant` a BILL the account holder pays on a standing arrangement — a subscription, a utility, rent, insurance, a membership, a delivery plan — rather than a shop or service they simply visit often?",
    notes: [
      "What decides is what the merchant IS. A grocery shop, a café, a taxi or a marketplace used on a regular schedule is NOT a bill, however regular it looks.",
      "A bill stays a bill when its amount moves from month to month.",
      "`near_miss` means a rule-based detector excluded this merchant and asks to reconsider it: «shop» = charges at several prices, «ragged» = uneven gaps between charges. Judge it by the same standard.",
    ],
  },
  criteria: {
    true: "A subscription, a utility or bill-payment service, rent, insurance, a membership, a delivery plan",
    false: "A shop, a café, transport, a pharmacy, a post office, a marketplace — visited, not subscribed to",
  },
};

const KIND: JudgeQuestion = {
  type: "choice",
  instructions: "What kind of business is `merchant`?",
  criteria: Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, v.rubric])),
};

export interface JudgedVerdict { merchant: string; verdict: "subscription" | "not" | "unsure"; reason: string }

/**
 * Verdicts for every row, or null when Jev is off or ANY request failed — the caller then runs the
 * Claude batch for the whole list, so one pass never mixes two judges' reasons.
 */
export async function judgeSubs(env: Env, rows: RecurringCandidate[]): Promise<JudgedVerdict[] | null> {
  if (!judgeOn(env) || !rows.length) return null;
  const loc = await resolveLocale(env);
  try {
    return await Promise.all(rows.map(async (c) => {
      const { answers } = await judge(env, {
        merchant: c.merchant,
        // The same evidence the Claude payload carries, in whole units (§AI-UNIT).
        amount: Math.round(c.amount / 100),
        currency_code: c.currency_code,
        charges: c.n,
        months: c.months,
        every_days: c.avg_interval_days,
        near_miss: c.near_miss ?? null,
      }, { bill: BILL, kind: KIND });
      // A malformed answer is a failure, not a coin: 0.5 would now read as «subscription».
      if (answers.bill.type !== "noul") throw new Error("answer of the wrong type");
      const p = answers.bill.noul;
      const type = answers.kind.type === "choice" ? TYPES[answers.kind.choice] ?? TYPES.unclear : TYPES.unclear;
      return {
        merchant: c.merchant,
        verdict: p >= SUB_AT ? "subscription" : p <= NOT_AT ? "not" : "unsure",
        reason: st(loc, type.key),
      } satisfies JudgedVerdict;
    }));
  } catch (e) {
    console.warn(`[jev] subs-review fell back to Claude: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
