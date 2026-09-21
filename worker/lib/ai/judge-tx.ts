// docs/JEV.md phases 1–2 — one transaction understood by Jev.
//
// This is still the MEASUREMENT branch, not the product: it answers the same `EnrichResult` the
// Haiku ladder answers, so `applyEnrichment` files both identically and `npm run eval` scores both
// with the same numbers. Which one ships is decided from that table (docs/JEV.md §7), not here.
//
// Lives in its own file because `enrich.ts` sits under the C3 ceiling and cannot take it; the only
// trace in `enrich.ts` is the two-line dispatch at the top of `enrichTransaction`.
//
// Two rounds, because the second one's options do not exist until the first has answered:
//   1. root category · kind · recurring · which span of the raw text is the brand — together;
//   2. the leaf, over the chosen root's children — only when that root HAS children.
// Not answered here: `note` and tags (generative / secondary — nothing computes from them), and
// `known_plan`: the deterministic `matchActiveSubscription` in `applyEnrichment` already links a
// charge to a declared plan, and does it better now that it is handed a clean name (docs/JEV.md §9).
import type { Env } from "../../env.ts";
import type { AnthropicUsage } from "./cost.ts";
import type { EnrichResult } from "./enrich.ts";
import { judge, judgeOn, type JudgeAnswer, type JudgeQuestion, type JudgeUsage, type Rubric } from "./judge.ts";
import { CAT_EN } from "../finance/categories-i18n.ts";
import { categoryGuide } from "./judge-guide.ts";

// Seeded «Перекази і зняття» (0002). Offered on BOTH signs: own money moving is neither spending
// nor income, and it is the bucket §F2 step 2 picks up from.
const TRANSFER_ROOT = 13;

/**
 * `recurring` is a probability; the column is 0/1. 0.5 is the neutral line, not a tuned one —
 * the Haiku prompt says «when unsure, false» because a wrong `true` plants a suggestion the user
 * must dismiss, and the eval's recurring column is what should move this, not intuition.
 */
const RECURRING_AT = 0.5;

const KIND: JudgeQuestion = {
  type: "choice",
  instructions: "What kind of money movement is this bank operation, judged from the viewpoint of the account holder?",
  criteria: {
    expense: "Paying for goods or a service, a fee, a tax, or money given to someone else for good",
    income: "Money earned or received from someone else: salary, payment for work, a sale, cashback, interest, a gift, a refund — including salary the user says they received in crypto and cashed out via P2P",
    transfer: "The account holder's OWN savings moving between their own cards, accounts, jars, deposits or crypto wallets, with no new money earned",
    withdrawal: "Cash taken out at an ATM or a cash desk",
  },
};

const RECURRING: JudgeQuestion = {
  type: "noul",
  instructions: "Is this operation a bill that comes back every period for an ongoing service, rather than a one-off purchase?",
  criteria: {
    true: "A recurring bill, whatever the period: streaming, software, cloud, a mobile tariff or mobile top-up, internet, utility bills, a building association (ОСББ) fee, a gym membership, an insurance premium (even yearly), a domain renewal",
    false: "A one-off purchase, groceries, a restaurant, transport, a transfer, income, or a single app, game or device bought outright — even from a store that also sells subscriptions",
  },
};

/**
 * §6 «Вагомість», asked of ONE operation (docs/JEV.md §3, phase 3). The canon reads importance off
 * the CATEGORY, so a taxi to a hospital and a taxi to a bar are equally «discretionary»; this is
 * the per-row answer. The three levels are the canon's own, in its order, and their wording is the
 * one the Stats tooltip already shows people («не поріжеш / гнучкі / можна не робити»).
 * Written as a PROPOSAL (`ai_importance`, migration 0054) — never into the override the canon reads.
 */
const IMPORTANCE_LEVELS = ["essential", "discretionary", "optional"] as const;
const IMPORTANCE: JudgeQuestion = {
  type: "score",
  instructions: "How necessary was this spending for the account holder's everyday life?",
  criteria: [
    "Essential: a basic need that cannot be cut — food at home, rent, utilities, medicine, getting to work, taxes",
    "Discretionary: wanted and flexible — could be smaller or cheaper, but is a normal part of life (eating out, clothes, a streaming plan)",
    "Optional: could simply not have happened — an impulse buy, a treat, a gadget or a game nobody needed",
  ],
};

/**
 * §TAX-BASE, asked of ONE operation. Today the answer is inherited from the account and changed by
 * hand, and the business page stays empty until someone goes and marks things. Stored as the raw
 * probability (`ai_business`, migration 0054) so the screen's threshold can move without asking
 * again — and NEVER copied into `is_business` by code: it moves a tax figure.
 */
const BUSINESS: JudgeQuestion = {
  type: "noul",
  instructions: "Is this operation part of the account holder's WORK or business, rather than their personal life?",
  criteria: {
    true: "Work money: a client paying for work or services, a payout from a freelance platform, software, hosting or tools used for work, a business tax or contribution, a fee on a business account",
    false: "Personal life: groceries, eating out, leisure, clothes, family, personal transfers, personal subscriptions — and a salary from an employer, which is employment, not the holder's own business",
  },
};

/**
 * Below this confidence on the ROOT, Jev does not file the row — the Haiku ladder does.
 *
 * The held-out run (docs/JEV.md §7.2) showed where Jev is weak: a brand it has never heard of,
 * which it files under «Other» rather than admit it does not know. That is not a wrong judgment
 * of the TEXT, it is missing world knowledge, and a model that has it is one fallback away. So the
 * cheap judge answers what it is sure of and hands on the rest: a cascade, not a replacement.
 * Measured, not chosen (§7.2): on 110 asked cases every root at ≥ 0.8 was right, 102 of them;
 * the 8 below held all 6 misses.
 */
export const ROOT_CASCADE_AT = 0.8;

/**
 * The leaf is filed only above this probability; below it the ROOT is filed (docs/JEV.md §3).
 * An answer one level up is still a correct answer — everything rolls up to it anyway.
 */
export const LEAF_AT = 0.6;

type Tx = Parameters<typeof import("./enrich.ts").enrichTransaction>[1];
type Option = { id: number; guide: Rubric | null };

/** A category's criterion: the guide's text, plus the raw descriptions it files there. */
export function criterion(id: number, extraExamples: string[] = []): Rubric | null {
  const g = categoryGuide(id);
  if (!g) return null;
  const examples = [...g.examples, ...extraExamples];
  return examples.length ? { covers: g.covers, examples } : g.covers;
}

/** Roots offered for this sign, as option-key → id, and every seed category's parent. */
export async function options(env: Env, income: boolean): Promise<{ roots: Map<string, Option>; children: Map<number, { id: number; name: string }[]> }> {
  const rows = await env.DB.prepare(
    "SELECT id, name, parent_id, is_income FROM categories ORDER BY id",
  ).all<{ id: number; name: string; parent_id: number | null; is_income: number }>();
  const all = rows.results ?? [];
  const children = new Map<number, { id: number; name: string }[]>();
  for (const r of all) {
    if (r.parent_id == null) continue;
    const list = children.get(r.parent_id) ?? [];
    list.push({ id: r.id, name: CAT_EN[r.name] ?? r.name });
    children.set(r.parent_id, list);
  }
  const roots = new Map<string, Option>();
  for (const r of all) {
    if (r.parent_id != null) continue;
    if (r.id !== TRANSFER_ROOT && !!r.is_income !== income) continue;
    let key = CAT_EN[r.name] ?? r.name;
    // Two categories can share a display name (a user's own «Other» beside the seed one); the key
    // must stay unique or one of them becomes unreachable.
    if (roots.has(key)) key = `${key} (#${r.id})`;
    // A root's examples include its leaves' — «GLOVO» is evidence for Cafés as much as for Delivery.
    const leafExamples = (children.get(r.id) ?? []).flatMap((c) => categoryGuide(c.id)?.examples ?? []);
    roots.set(key, { id: r.id, guide: criterion(r.id, leafExamples) });
  }
  return { roots, children };
}

const NO_BRAND = "none of these";

/**
 * Candidate brand names cut out of the raw description, for Jev to SELECT from (docs/JEV.md §8:
 * text generation is its weak spot, selection is not). Code decides what a candidate can be, so the
 * answer can only ever be a piece of what the bank actually sent — never a spelling Jev invented.
 *
 * Dropped before windowing: code-like tokens (≥2 digits mixed with letters — «N254», «P1A2B3C4D»,
 * but not «1PASSWORD»). A pure number stays INSIDE a window and never stands alone: «APTEKA 911»
 * is a brand and «ATB 1234» is a branch, and only a reader can tell which — so both are offered.
 * A token with a domain also offers its bare name («CITRUS.UA» → «CITRUS»).
 */
export function brandCandidates(raw: string | null): string[] {
  if (!raw) return [];
  const tokens = raw.split(/[\s*/]+/).filter((t) => t && !(/\d.*\d/.test(t) && /\p{L}/u.test(t)) && !/^[#№]/.test(t));
  const bare = tokens.map((t) => t.replace(/^([\p{L}\d-]+)\.(?:com|ua|net|eu|org|io)(?:\.\p{L}+)?$/iu, "$1"));
  const out = new Set<string>();
  for (const seq of [tokens, bare]) {
    for (let i = 0; i < seq.length; i++) {
      for (let n = 1; n <= 4 && i + n <= seq.length; n++) {
        const w = seq.slice(i, i + n);
        if (/^\d+$/.test(w[0])) break; // a window never STARTS with a number
        out.add(w.join(" "));
      }
    }
  }
  return [...out].slice(0, 60);
}

/** «SILPO» → «Silpo»; short all-caps words («WOG», «ATB», «OKKO») are left alone as acronyms. */
function displayName(span: string): string {
  return span.split(" ").map((w) => (/^[A-Z][A-Z-]{4,}$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)).join(" ");
}

/** The most probable level of a Score — a level, not the weighted mean: the column holds a level. */
function topLevel(p: Record<string, number>): number {
  const [k] = Object.entries(p).sort((a, b) => b[1] - a[1])[0] ?? ["1"];
  return Math.min(IMPORTANCE_LEVELS.length - 1, Math.max(0, Number(k) || 0));
}

function addUsage(a: JudgeUsage, b: JudgeUsage): JudgeUsage {
  return { input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens };
}

/**
 * The Jev branch of `enrichTransaction`. Returns null when it should not run (flag off, no key,
 * not the owner, a demo), when it failed, OR when it is not sure of the root — null always means
 * «use the Haiku ladder», so the webhook degrades instead of losing the verdict (docs/JEV.md §10).
 */
export async function judgeTransaction(
  env: Env,
  tx: Tx,
): Promise<{ result: EnrichResult; usage: AnthropicUsage } | null> {
  if (!judgeOn(env)) return null;
  try {
    const income = tx.amount > 0;
    const { roots, children } = await options(env, income);
    // `user_note` leads: it outranks every other field (the Haiku prompt's PRIORITY 1), and a note
    // buried after the MCC lost to it on the first eval run (SILPO + «розваги» → Groceries).
    const state = {
      user_note: tx.user_note?.trim() || null,
      raw_description: tx.merchant,
      bank_comment: tx.comment,
      mcc: tx.mcc,
      // Plausibility context only — never arithmetic (docs/JEV.md §2: the amount is the bank's).
      amount: tx.amount / 100,
      currency_code: tx.currency_code,
      sign: income ? "incoming" : "outgoing",
      current_category: tx.current_category ?? null,
      merchant_history: tx.history ?? null,
      user_profile: tx.profile ?? null,
      known_subscriptions: tx.subscriptions ?? null,
    };
    const spans = brandCandidates(tx.merchant);
    const questions: Record<string, JudgeQuestion> = {
      root_category: {
        type: "choice",
        instructions: {
          question: "Which category does this bank operation belong to — what was the money actually for?",
          rules: [
            "If `user_note` says what the operation was, it outranks everything else, including the MCC.",
            "If `merchant_history` shows how the user classified this merchant before, agree with it unless `user_note` says otherwise.",
            "An incoming transfer from a private person is not automatically a gift: if the note or `user_profile` says it is salary or the user's own money, it is not.",
          ],
        },
        criteria: Object.fromEntries([...roots].map(([k, v]) => [k, v.guide])),
      },
      kind: KIND,
      recurring: RECURRING,
      business: BUSINESS,
    };
    if (spans.length) {
      questions.brand = {
        type: "choice",
        instructions: "Which of these pieces of `raw_description` is the merchant's name as a person would say it — without the city, branch or terminal number, country code, or a payment processor's prefix?",
        criteria: { ...Object.fromEntries(spans.map((s) => [s, null])), [NO_BRAND]: "The description names no merchant (a transfer to a person, a tax payment, a bank's own wording)" },
      };
    }
    const first = await judge(env, state, questions);
    const { root_category: rootA, kind: kindA, recurring: recA, brand: brandA, business: bizA } = first.answers;
    if (rootA.type !== "choice" || kindA.type !== "choice" || recA.type !== "noul") throw new Error("answer of the wrong type");
    let usage = first.usage;

    const root = roots.get(rootA.choice)?.id ?? null;
    let kind = kindA.choice as EnrichResult["kind"];
    // Questions cannot see each other (docs/JEV.md §8), so «transfer» can come back beside a
    // category that says otherwise. The MORE CERTAIN of the two wins. «kind always wins» was tried
    // first and made the run flaky: UKLON came back Transport at 0.99 beside `kind` transfer at
    // ~0.5, and a coin flip on the weaker question overrode the confident one.
    const ownMoney = (kind === "transfer" || kind === "withdrawal") &&
      (root === TRANSFER_ROOT || kindA.probabilities[kind] > rootA.probabilities[rootA.choice]);
    if (!ownMoney && root === TRANSFER_ROOT) kind = "transfer"; // the bucket IS the answer then
    else if (!ownMoney && (kind === "transfer" || kind === "withdrawal")) kind = income ? "income" : "expense";

    // The cascade. Own money moving is exempt: the transfer bucket is where §F2 step 2 asks the
    // real question anyway, so an unsure «transfer» is not worth a Haiku call.
    const rootP = rootA.probabilities[rootA.choice] ?? 0;
    if (!ownMoney && rootP < ROOT_CASCADE_AT) {
      console.log(`[jev] root «${rootA.choice}» at ${rootP.toFixed(2)} — handing to the Haiku ladder`);
      return null;
    }

    // Round 2 — what needs the ROOT to be known: the leaf (its options are the root's children)
    // and importance. Importance was asked in round 1 until §7.4 measured it both ways: blind to
    // the category it read Novus and Fora as «discretionary» (86%); told «this is Groceries» it
    // is a different, easier question. Spending only — income has no «how necessary», and own
    // money moving is neither.
    let category = ownMoney ? TRANSFER_ROOT : root;
    const kids = category != null && !ownMoney ? children.get(category) ?? [] : [];
    const general = `${rootA.choice} (none of the specific ones)`;
    const round2: Record<string, JudgeQuestion> = {};
    if (kids.length) {
      round2.leaf = {
        type: "choice",
        instructions: `This operation is «${rootA.choice}». Which subcategory fits it best?`,
        criteria: {
          ...Object.fromEntries(kids.map((k) => [k.name, criterion(k.id)])),
          [general]: "It belongs to the category, but none of the subcategories describes it",
        },
      };
    }
    if (!income && !ownMoney) {
      round2.importance = { ...IMPORTANCE, instructions: { category: rootA.choice, question: IMPORTANCE.instructions } };
    }
    let impA: JudgeAnswer | undefined;
    if (Object.keys(round2).length) {
      const second = await judge(env, state, round2);
      usage = addUsage(usage, second.usage);
      const leafA = second.answers.leaf;
      if (leafA?.type === "choice" && leafA.choice !== general && (leafA.probabilities[leafA.choice] ?? 0) >= LEAF_AT) {
        category = kids.find((k) => k.name === leafA.choice)?.id ?? category;
      }
      impA = second.answers.importance;
    }

    const brand = brandA?.type === "choice" && brandA.choice !== NO_BRAND ? displayName(brandA.choice) : "";
    return {
      result: {
        // Empty keeps the name the deterministic ladder already gave the row (`applyEnrichment`).
        clean_name: brand,
        category_id: category,
        kind,
        tag_ids: [],
        note: null,
        recurring: ownMoney ? false : recA.noul >= RECURRING_AT,
        // Proposals (migration 0054). Own money moving is neither spending nor work.
        importance: !ownMoney && impA?.type === "score" ? IMPORTANCE_LEVELS[topLevel(impA.probabilities)] : undefined,
        business: !ownMoney && bizA?.type === "noul" ? bizA.noul : undefined,
      },
      usage,
    };
  } catch (e) {
    console.warn(`[jev] enrich fell back to the Haiku ladder: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
