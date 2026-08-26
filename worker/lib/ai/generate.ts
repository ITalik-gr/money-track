/**
 * L6 — the one-shot GENERATIONS: calls that produce a finished artefact from a payload, with
 * nobody waiting mid-conversation.
 *
 * Split from `tasks.ts` (2026-08-08) when the C3 size check refused it another line — the prompts
 * had just been rewritten in English, which is longer than the Ukrainian they replaced. The seam
 * is the one the code already had: `tasks.ts` keeps the CONVERSATIONAL surface (chat, per-operation
 * chat, budget chat), where a human turn is the input and the answer streams back; this file keeps
 * the generators (budget plan, feed observations, advice, group verdict), which take a payload,
 * return structured JSON and are usually run by a background job.
 *
 * They differ in more than shape: a generator's output is validated in code before it is stored
 * (`numbersAreGrounded`, `callHaikuJson`'s `validate`), because nobody is reading it live to notice
 * it is wrong.
 *
 * ⚠️ Prompts here name NO language and are written in English — see §LANG in CLAUDE.md.
 */
import type { Env } from "../../env.ts";
import type { AnthropicContentBlock } from "./ai.ts";
import { callHaikuJson } from "./json.ts";
import { replyLangDirective, moneyUnitDirective } from "./prompt.ts";
import { getTaskModel } from "./models.ts";
import type { AnthropicUsage } from "./cost.ts";
import type { StructuredInsight } from "./insight.ts";

// AI-планувальник бюджету (§ візія): з історії витрат + ситуації користувача пропонує
// місячні ліміти-конверти по кожній категорії з коротким обґрунтуванням.
export interface BudgetPlan {
  proposals: { category_id: number; limit_uah: number; reason: string }[];
  overall: string;
}

export async function proposeBudgetLimits(
  env: Env,
  payload: unknown,
): Promise<{ result: BudgetPlan; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "You are a financial planner. From the user's situation (situation), their figures (own funds, monthly " +
        "burn, runway in months) and their 3-month average spending per category " +
        "(categories: [{id, name, avg_month_uah, current_limit_uah}]), propose sensible MONTHLY envelope limits for " +
        "EVERY category supplied (same id). If runway is short or the goal is saving, propose a realistic reduction " +
        "in discretionary spending (entertainment, cafés, subscriptions, clothes), but do not over-cut the basics " +
        "(groceries, utilities, health). Limits are WHOLE numbers of the display currency — neither inflated nor zero. Answer " +
        "with VALID JSON ONLY: {proposals:[{category_id, limit_uah, reason}], overall} — reason is one short " +
        "phrase, overall is 1-2 sentences about the logic of the plan. No markdown." +
        // Без цієї директиви план бюджетів приходив українською навіть на англійському екрані:
        // `reason`/`overall` — це текст, який читає користувач, а не ключі JSON.
        (await replyLangDirective(env)) + (await moneyUnitDirective(env)),
    },
  ];
  return callHaikuJson<BudgetPlan>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 2200, await getTaskModel(env, "budget"));
}

// Спільний структурований «факт» для стилізованого рендеру (гроші/категорії/дельти).
export interface AiFact {
  label: string;
  amount?: number | null;    // грн (major), число або null
  category?: string | null;  // назва категорії, якщо доречно
  delta_pct?: number | null; // зміна проти минулого періоду, +/-
  tone?: "pos" | "neg" | "neutral" | null;
}

// Дія, яку можна виконати прямо з поради (§дієві поради).
export interface AdviceAction {
  type: "create_budget";
  label: string;              // текст кнопки
  category_id?: number | null;
  category_name?: string | null;
  amount_uah?: number | null; // для create_budget — ліміт у грн
}

// Структуровані фінансові поради під ситуацію користувача (§advisor).
export interface AdviceResult {
  runway_comment: string;                         // 1-2 речення про запас/скільки протягнеш
  summary: string;                                // короткий підсумок ситуації
  facts: AiFact[];                                // 2-5 ключових фактів для стилізації
  suggestions: { title: string; detail: string; action?: AdviceAction | null }[]; // 3-5 кроків
}

// Спостереження для стрічки сповіщень (Центр сповіщень, kind='ai'). Модель НЕ рахує —
// вона лише називає людською мовою те, що вже пораховано канонічно (collectFinanceSnapshot).
// Це і є різниця з «тупим алертом»: не «поріг перевищено», а що змінилось і що з цим робити.
export interface NotifyObservation { title: string; body: string; severity?: string }
export async function generateNotifyObservations(
  env: Env,
  payload: unknown,
): Promise<{ result: { observations?: NotifyObservation[] }; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "You are a personal financial assistant. You look at a snapshot of the user's finances and write 0-2 SHORT " +
        "observations for the notification feed. " +
        "⚠️ ABOVE ALL: use ONLY numbers present in the payload. Do NOT compute new sums, do NOT multiply, do NOT " +
        "estimate by eye, do NOT invent figures that are not in the payload — no number is better than a made-up one. " +
        "You must be able to point at every amount you write inside the payload; an amount that is not there " +
        "automatically discards the whole observation. " +
        "🚫 NO approximations: not \"5000+\", not \"about 3k\", not \"~4000\" — either the exact number from the " +
        "payload, or no number. " +
        "🚫 ONE AMOUNT PER FACT: if you named an amount in title, repeat THAT SAME amount in body, not another " +
        "estimate of the same thing (\"N subscriptions cost 4820 UAH/mo … that is 5000+ UAH/mo\" is a gross error — " +
        "two different figures for one thing). " +
        "🚫 Do NOT attach a period to an amount that the payload does not give it (\"X over 27 days\" when the period " +
        "is different): state the period exactly as supplied. " +
        "⚠️ PERIODS: monthly_burn_uah is ALREADY a monthly average; categories carry both spent_90d_uah and " +
        "avg_month_uah — use avg_month_uah for comparisons, and never call a 90-day total monthly. " +
        "An observation must be ACTIONABLE: not \"spending went up\", but what exactly changed and what is worth " +
        "doing about it. " +
        "Do NOT duplicate what already has its own notification: exceeded budget, subscription deadline, price " +
        "increase, category pace anomaly, liquidity gap, health index. The payload carries " +
        "already_announced_today — the events the app has ALREADY written into the feed in this same run, in the " +
        "reader's own words. Say none of them again, in any wording. Look for what deterministic detection does " +
        "NOT catch: a shift in the structure of spending, the accumulated effect of small amounts, a link between " +
        "categories, a consequence of the user's situation (situation). " +
        // The calendar half of the "no invented figures" rule. Shipped 2026-08-26: «Rent due in 11
        // days» for a rent paid on the 20th — read out of the user's own prose in `situation`,
        // which is not a schedule, for a payment that is in no upcoming_charges row.
        "📅 DATES: your ONLY calendar is today, day_of_month, days_left_in_month, runway_days and the " +
        "upcoming_charges rows (in_days / date / on_day). Never state a due date, a countdown or an \"in N days\" " +
        "for anything that is not one of those rows — a payment that repeats every month in the history but is not " +
        "there has NO known date. Never name a month the payload does not name. ⚠️ situation is the user's own " +
        "prose: \"I pay rent on the 20th\" is background, NOT a schedule you may turn into a deadline. An " +
        "observation carrying a date that is not in the payload is discarded whole, like an invented amount. " +
        "If nothing is genuinely worth attention, return an empty array. That is a normal and correct answer: " +
        "silence beats noise. " +
        // Спостереження генеруються ЩОДНЯ на майже незмінному знімку, тож без цього блоку модель
        // щоранку переказує ту саму думку іншими словами («на скільки вистачить запасу»), і
        // Telegram перетворюється на щоденну розсилку однієї фрази. Дедуп за змістом стоїть і в
        // коді (`notify.ts`), але він ловить лише однакове формулювання — тему ловити тут.
        "🚫 DO NOT REPEAT YOURSELF: the payload carries recent_observation_titles — the topics you already wrote " +
        "about in the last two weeks. Do not restate them in different words (even if the number moved slightly); " +
        "find something NEW. If there is nothing new, an empty array beats a paraphrase. " +
        // The jargon rule stays, the language claim does not: this said «МОВА: природна
        // українська» AND banned English words outright, which contradicted the directive below.
        // ⚠️ The example below is English and the answer often is not. Before this line said so, the
        // feed carried English HEADLINES over Ukrainian bodies — one card, two languages — because
        // an illustration in a language outvotes a directive about language.
        "STYLE: title is a noun phrase, like a news headline — the example \"Card debt is eating the cushion\" (as " +
        "opposed to \"Tiny income vs flat does not make\") illustrates the SHAPE only; write the title in the " +
        "answer's own language, never in the language of these instructions. No internal jargon in the text: not " +
        "\"optional/discretionary\" but \"non-essential " +
        "spending\"; not \"burn\" but \"monthly spending\"; not \"runway\" but \"how long the money lasts\" — in the " +
        "answer's own language. " +
        "title ≤ 60 characters, body ≤ 200 characters, no markdown. " +
        'Answer with VALID JSON ONLY: {"observations":[{"title","body","severity":"info"|"warn"}]}' +
        (await replyLangDirective(env)) + (await moneyUnitDirective(env)),
    },
  ];
  return callHaikuJson<{ observations?: NotifyObservation[] }>(
    env, system, [{ type: "text", text: JSON.stringify(payload) }], 700, await getTaskModel(env, "notify"),
  );
}


export async function generateAdvice(
  env: Env,
  payload: unknown,
): Promise<{ result: AdviceResult; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "You are a personal financial adviser. From the description of the user's situation (situation) and their " +
        "figures (own funds, monthly burn, runway in months, top categories, top merchants), give practical advice. " +
        "⚠️ PERIODS: monthly_burn_uah is ALREADY a monthly average; the amounts in top_categories/top_merchants/" +
        "by_event are given both for 90 days (spent_90d_uah) and per month (avg_month_uah). For advice and for " +
        "comparisons against income or burn, use avg_month_uah, NOT the 90-day total — never call three months' " +
        "accumulation monthly. " +
        "🚫 NOT \"BY THE BOOK\": treat situation as a hard constraint. If the user is out of work, between jobs or " +
        "job-hunting, do NOT give abstract advice to \"increase income\", \"add an income stream\" or \"budget for " +
        "income\". Instead: extending runway, cutting optional/discretionary, using the liquid cushion. No generic " +
        "advice that would fit anyone — every suggestion must rest on THEIR specific numbers and categories. " +
        "💰 FUNDS, HONESTLY: liquid_cushion_uah is the real reserve (savings, accounts in the positive); debt_uah is " +
        "credit-card debt. own_funds_uah (net) can be NEGATIVE because of debt — that is NOT \"negative savings\", " +
        "the real cushion is separate. Compute and interpret runway from the cushion. " +
        "🏦 ACCOUNTS: payload.accounts lists accounts with their role and DESCRIPTION (note). role='investment' " +
        "(crypto, brokerage) inside investment_reserve_uah is NOT the liquid cushion and NOT part of runway; mention " +
        "it as a separate reserve or last line, and do not propose selling investments unless the situation is " +
        "critical. Treat each account's note as context. " +
        "recent_oneoff holds the month's one-off expenses (taxes, doctor): do NOT treat them as recurring and do not " +
        "project them forward. " +
        "The payload carries citable_operations:[{id,label}] — when you mention a specific operation in summary or " +
        "suggestions.detail, put the token [tx:ID] with the matching id right after its name (e.g. \"Rozetka " +
        "[tx:abc]\"). Only ids that exist, never invented, 1-2 where apt. " +
        "Be specific and empathetic, no filler and no markdown. Answer with VALID JSON ONLY: " +
        "{runway_comment, summary, " +
        "facts:[{label, amount (UAH number or null), category (name or null), delta_pct (number or null), tone ('pos'|'neg'|'neutral')}] (2-5 key facts), " +
        "suggestions:[{title, detail, action}]} — 3-5 pieces of advice, each actionable (what exactly to cut or do, " +
        "and the effect as an amount). action is either null or {type:'create_budget', label, category_id (from " +
        "top_categories), category_name, amount_uah} when proposing an envelope limit for a category makes sense. " +
        "Amounts are WHOLE units of the display currency named below." +
        (await replyLangDirective(env)) + (await moneyUnitDirective(env)),
    },
  ];
  return callHaikuJson<AdviceResult>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 2200, await getTaskModel(env, "advisor"));
}


// §GR2: оцінка групи/події — вплив на бюджет, чи дорого, чи варте. Структурований JSON,
// може цитувати конкретні транзакції групи як [tx:ID|короткий підпис] (фронт зробить чип).
export async function evaluateGroup(
  env: Env,
  payload: unknown,
): Promise<{ result: StructuredInsight; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "You are a financial assistant. Assess one specific GROUP of the user's spending (a trip, an event, a " +
        "project) from the figures supplied (amounts in whole currency units): what it cost, how that compares with monthly burn and " +
        "the reserve (runway), whether it is expensive, where most of it went, whether there are anomalies. If the " +
        "payload carries transactions:[{id,label}] you may point at a notable operation inside facts.label or note " +
        "as [tx:ID|short caption] (e.g. [tx:abc|MrGrill 150]). " +
        "Answer with VALID JSON ONLY, no markdown: {headline (1 sentence — the main conclusion about the group), " +
        "facts:[{label, amount (UAH number or null), category (name or null), delta_pct (usually null), " +
        "tone ('pos'|'neg'|'neutral')}] (2-5), note (one short piece of advice, or a verdict on whether it was " +
        "expensive, or null)}." +
        // `headline`/`facts.label`/`note` читає людина — див. сусідні задачі.
        (await replyLangDirective(env)) + (await moneyUnitDirective(env)),
    },
  ];
  return callHaikuJson<StructuredInsight>(env, system, [{ type: "text", text: JSON.stringify(payload) }], 800, await getTaskModel(env, "group"));
}
