// docs/JEV.md phase 1 — one transaction, one request, three judgments.
//
// This is the MEASUREMENT branch, not the product: it answers the same `EnrichResult` the Haiku
// ladder answers, so `applyEnrichment` files both identically and `npm run eval` scores both with
// the same six numbers. Which one ships is decided from that table (docs/JEV.md §7), not here.
//
// Lives in its own file because `enrich.ts` sits under the C3 ceiling and cannot take it; the only
// trace in `enrich.ts` is the two-line dispatch at the top of `enrichTransaction`.
//
// What phase 1 deliberately does NOT answer, and why the result still files correctly:
//   • the LEAF category — its options only exist once the root is known, so it is a second round
//     (phase 2). A root is not a consolation prize: every total in the app rolls up to it anyway.
//   • `clean_name` — returned empty, so `applyEnrichment` keeps the name the deterministic ladder
//     already gave the row. Phase 2 makes it span SELECTION, never generation (§8).
//   • `note`, tags — generative / secondary; nothing computes from them.
import type { Env } from "../../env.ts";
import type { AnthropicUsage } from "./cost.ts";
import type { EnrichResult } from "./enrich.ts";
import { judge, judgeAvailable, type JudgeQuestion, type Rubric } from "./judge.ts";
import { CAT_EN } from "../finance/categories-i18n.ts";

// Seeded «Перекази і зняття» (0002). Offered on BOTH signs: own money moving is neither spending
// nor income, and it is the bucket §F2 step 2 picks up from.
const TRANSFER_ROOT = 13;

/**
 * `recurring` is a probability; the column is 0/1. 0.5 is the neutral line, not a tuned one —
 * the Haiku prompt says «when unsure, false» because a wrong `true` plants a suggestion the user
 * must dismiss, and the eval's recurring column is what should move this, not intuition.
 */
const RECURRING_AT = 0.5;

/**
 * What each SEED root means, keyed by id. Condensed from `CACHE_GUIDE` in `prompt.ts` — the same
 * boundaries (delivery is Other, not Transport; there is no «subscriptions» category, §SUBS-CAT),
 * because two definitions of one category would disagree exactly on the rows that are hard.
 * A user's own category has no entry and is offered by name alone.
 */
const ROOT_GUIDE: Record<number, Rubric> = {
  1: "Groceries: supermarkets (АТБ, Сільпо, Novus, Varus, Fora), corner shops, markets, bakeries",
  2: "Cafés & restaurants: food and drink away from home — coffee shops, restaurants, fast food, bars, food delivery (Glovo, Bolt Food)",
  3: "Transport: taxi (Uber, Bolt, Uklon), fuel (WOG, OKKO, UPG), public transport, car sharing, parking",
  4: "Health: pharmacies, doctors, clinics, labs, dentists, optics",
  5: "Clothing & shoes: clothes, footwear, bags, accessories — Zara, H&M, Reserved, Intertop, LC Waikiki, Sinsay",
  6: "Entertainment: leisure — cinema, concerts, games (Steam, PlayStation), streaming services (Netflix, Spotify, YouTube Premium, MEGOGO, Sweet.tv)",
  7: "Utilities & connectivity: mobile operators (Київстар, Vodafone, lifecell), internet providers, electricity, gas, water, ОСББ",
  8: "Home & household: furniture, hardware, repairs, cleaning supplies, decor (IKEA, JYSK, Епіцентр)",
  9: "Electronics: gadgets and appliances — Rozetka, Comfy, Foxtrot, Allo, Apple hardware, phones, laptops",
  10: "Beauty & care: hairdresser, barber, manicure, cosmetics, perfume (EVA, Watsons)",
  11: "Travel: flights, hotels, Booking, Airbnb, intercity trains, tours",
  [TRANSFER_ROOT]: "Transfers & withdrawals: ATM cash, card-to-card to a person, moving money between the user's own accounts, jars or crypto wallets",
  14: "Other: postal delivery (Нова пошта, Укрпошта, Meest), fines, bank fees, one-off odds and ends with no clear category",
  15: "Salary: regular salary or advance from an employer",
  16: "Freelance: payment for work or services — invoices, clients, Upwork, Deel, Payoneer",
  17: "Refund: money returned for a cancelled or returned purchase",
  18: "Other income: income not covered by any other income category",
  19: "Education: courses, tutors, textbooks, university, language schools",
  20: "Children: toys, children's clothes, nursery, clubs, nappies",
  21: "Pets: pet shops, pet food, vets",
  22: "Sports & fitness: gym membership, sports nutrition, equipment, pools, yoga",
  23: "Gifts: gifts bought for other people — flowers, souvenirs, gift sets",
  24: "Taxes: taxes and state fees — ЄП, ЄСВ, military levy, ПДФО, treasury (казначейство), ДПС",
  43: "Software & cloud: AI tools, hosting, domains, cloud storage, VPN, developer and productivity software (OpenAI, Anthropic, GitHub, iCloud, Google One, Adobe, Notion)",
  44: "Sale: selling one's own things — OLX, Prom",
  45: "Cashback: bank cashback and bonuses",
  46: "Interest: interest on a balance or deposit",
  47: "Gift: money received as a gift",
};

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

type Tx = Parameters<typeof import("./enrich.ts").enrichTransaction>[1];

/** Roots offered for this sign, as option-key → id. Keys are names, because the model reads them. */
async function rootOptions(env: Env, income: boolean): Promise<Map<string, { id: number; guide: Rubric | null }>> {
  const rows = await env.DB.prepare(
    "SELECT id, name, is_income FROM categories WHERE parent_id IS NULL ORDER BY id",
  ).all<{ id: number; name: string; is_income: number }>();
  const out = new Map<string, { id: number; guide: Rubric | null }>();
  for (const r of rows.results ?? []) {
    if (r.id !== TRANSFER_ROOT && !!r.is_income !== income) continue;
    let key = CAT_EN[r.name] ?? r.name;
    // Two categories can share a display name (a user's own «Other» beside the seed one); the key
    // must stay unique or one of them becomes unreachable.
    if (out.has(key)) key = `${key} (#${r.id})`;
    out.set(key, { id: r.id, guide: ROOT_GUIDE[r.id] ?? null });
  }
  return out;
}

/**
 * The Jev branch of `enrichTransaction`. Returns null when it should not run (flag off, no key,
 * not the owner, a demo) OR when it failed — null always means «use the Haiku ladder», so the
 * webhook degrades instead of losing the verdict (docs/JEV.md §10).
 */
export async function judgeTransaction(
  env: Env,
  tx: Tx,
): Promise<{ result: EnrichResult; usage: AnthropicUsage } | null> {
  if (env.ENRICH_JUDGE !== "jev" || !judgeAvailable(env)) return null;
  try {
    const income = tx.amount > 0;
    const roots = await rootOptions(env, income);
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
    const { answers, usage } = await judge(env, state, {
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
    });

    const rootA = answers.root_category, kindA = answers.kind, recA = answers.recurring;
    if (rootA.type !== "choice" || kindA.type !== "choice" || recA.type !== "noul") throw new Error("answer of the wrong type");
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
    const recurring = recA.noul >= RECURRING_AT;
    return {
      result: {
        clean_name: "",
        category_id: ownMoney ? TRANSFER_ROOT : root,
        kind,
        tag_ids: [],
        note: null,
        recurring: ownMoney ? false : recurring,
      },
      usage,
    };
  } catch (e) {
    console.warn(`[jev] enrich fell back to the Haiku ladder: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
