// L6 — the tasks we ask the model to perform that have no feature file of their own.
//
// Everything with a home already went to it in phase 5: OCR to `receipt.ts`, categorisation and
// text parsing to `enrich.ts`, the report to `report.ts`, the insight to `insight.ts`. What is
// left is the CONVERSATIONAL surface — the adviser, the per-transaction chat, the budget chat,
// the group verdict, the feed observations — plus the shapes those answers come back in.
//
// Two rules that live with these calls rather than with the transport:
//  • **A number from the model that reaches the UI needs a deterministic check beside it**
//    (`numbersAreGrounded`). The prompt already forbade inventing sums; the model produced two
//    different figures for one thing in a single notification anyway.
//  • **The model does not know what it already said.** Repetition is cured by an EXPLICIT list of
//    what has been covered, not by asking it to "be interesting".
import type { Env } from "../../env.ts";
import { callHaikuMessages, runToolConversation, webSearchTool, type AnthropicContentBlock, type ChatMsg, type ChatTool, type OnText, type ToolExecutor } from "./ai.ts";
import { isDemoEnv } from "../platform/demo.ts";
import { buildKnowledgeCorpus } from "./knowledge/index.ts";
import { callHaikuMessagesJson } from "./json.ts";
import { buildSystemPrefix, replyLangDirective, moneyUnitDirective } from "./prompt.ts";
import { getTaskModel } from "./models.ts";
import type { AnthropicUsage } from "./cost.ts";
import { localYmd } from "../finance/time.ts";

/**
 * Output ceiling for a chat answer.
 *
 * 1500 was set when the answer appeared all at once, and a cut one simply looked short. The prompt
 * asks for a structured answer (висновок → числа → 2-4 кроки), and in Ukrainian a token is worth
 * roughly two characters, so a normal detailed reply overran the ceiling and stopped mid-word —
 * which streaming turned from "short" into "the app broke". `max_tokens` is a ceiling, not a
 * charge: raising it costs nothing on answers that were already finishing on their own.
 * `runToolConversation` still asks for a continuation if even this is not enough.
 */
const CHAT_MAX_OUTPUT = 4000;

export async function chatAdvice(
  env: Env,
  context: unknown,
  messages: ChatMsg[],
  opts?: { tools?: ChatTool[]; executor?: ToolExecutor; onText?: OnText },
): Promise<{ text: string; usage: AnthropicUsage }> {
  // §APP_TZ: the date the READER is living in, not the runtime's. Between midnight and 03:00
  // Kyiv, UTC is still yesterday — so the model was told the wrong day, and on the 1st of a month
  // it reasoned about the wrong month while every figure it was given came from the right one.
  const today = localYmd(Math.floor(Date.now() / 1000));
  // Demo: no server-side web_search (billed per search on top of tokens) and a shorter tool loop.
  // The prompt must match what is actually sent — describing a tool the request does not carry
  // makes the model try to call it and waste a turn. `demoClamp` still strips it as a backstop.
  const demo = isDemoEnv(env);
  const toolNote = opts?.tools?.length
    ? `Today is ${today}. You HAVE TOOLS for querying the user's FULL operation database (not just the context above): ` +
      "query_spend (total spending or income over a period, filterable by category or merchant, with grouping), " +
      "find_transactions (locate individual operations), list_categories (the category list). USE them whenever the " +
      "fixed context is not enough — e.g. a question about a specific past period, category or merchant (\"how much on " +
      "taxis last summer\", \"my biggest purchases in December\"). Work out the period dates (YYYY-MM-DD) yourself, " +
      "relative to today. Do NOT invent numbers — if you need exact data beyond the context, call a tool. " +
      "Operations returned by a tool can also be cited as [tx:ID|caption]. " +
      (demo
        ? ""
        : "You also have web_search over official sources (NBU exchange rates, tariffs, taxes, prices) for CURRENT " +
          "facts about the world that are not in your training data; use it ONLY for external facts, never for the " +
          "user's own operations, and cite the source. ")
    : "";
  // §A5: стабільний блок (корпус знань + персона/правила) з cache_control ttl:1h — байт-ідентичний
  // між викликами й користувачами, тож читається з кешу ≈0.1×. Динамічний контекст — окремим блоком
  // ПІСЛЯ (не кешується). Це ще й здешевлює: персона раніше слалась щоразу без кешу.
  const stableRules =
    // ⚠️ This prompt names NO language — that decision belongs to `replyLangDirective` alone, and
    // the prompt is written in English so that nothing here pulls the answer toward one. It used
    // to open with «Відповідай українською» in Ukrainian prose, and both the sentence and the
    // prose won over the directive: the persona is the FIRST system block and reads as a
    // definition of who the model is. See §LANG in CLAUDE.md.
    "You are the user's experienced personal financial manager inside the Money Track app — not a faceless bot, but " +
    "a seasoned adviser who looks after THIS person's money. Answer like a human, and to the point. Your job is not " +
    "to restate figures but to RECOMMEND DECISIONS: where to direct money, pay now or wait, what to cut first, how to " +
    "stretch the cushion, when it is safe to spend. Think like a manager who cares about the client: priorities, " +
    "timing, risk. " +
    "When the question is simple, be brief; when it is complex, or the user asks you to dig in or advise, answer " +
    "IN DETAIL and with structure (a short conclusion → the reasoning on their own numbers → 2-4 concrete, " +
    "actionable steps with the effect as an amount). " +
    "⚠️ FUNDS (critical — never conflate these): liquid_cushion_uah is the real liquid CUSHION (cash, cards, jars) " +
    "and the key number for \"how long do I last\". debt_uah is the used credit LIMIT — that is DEBT, not \"negative " +
    "savings\". investment_reserve_uah is crypto or brokerage: the last line of defence, NOT the cushion and NOT part " +
    "of runway; do not advise touching it unless the situation is critical. own_funds_uah = cushion − debt (net). " +
    "accounts lists the accounts with their role and description (note): take them into account, and do not assume " +
    "amounts beyond the context. runway_months = cushion / burn. " +
    "⚠️ PERIODS: monthly_burn_uah and avg_month_uah are ALREADY monthly averages; spent_90d_uah is a 90-day total. " +
    "When comparing against income or burn, use the monthly figures; never call a 90-day total monthly. " +
    "recent_oneoff holds one-off expenses (taxes, doctor): do not project them as recurring. upcoming_charges holds " +
    "the nearest charges (in_days): use them for advice about payment timing. " +
    "Formatting is markdown: **bold** for emphasis, \"- \" lists, short subheadings. " +
    "If the context contains transactions:[{id,label}] and it is apt to point at a specific operation, cite it as " +
    "[tx:ID|short caption] (e.g. [tx:abc|MrGrill 150]); the app turns that into a clickable chip. " +
    "📊 VISUALISATIONS — use SPARINGLY, only where they genuinely aid understanding (comparing several numbers, a " +
    "schedule, a plan by month). Do NOT attach a chart or table to every answer, and never when a sentence is enough. " +
    "At most one visualisation per answer, built only from real numbers in the context.\\n" +
    "• Mini chart (horizontal bars for comparison): a line \"[chart:Title]\", then one \"Label|number\" per line " +
    "(a bare number in whole currency units, no symbols), closed with \"[/chart]\". Example: [chart:Spending by category]\\nGroceries|4500\\n" +
    "Cafés|3200\\n[/chart]. Max 6 rows.\\n" +
    "• Table (when several columns are needed, e.g. a payoff plan or limit vs actual): a line \"[table:Title]\", then " +
    "a header row \"Col1|Col2|Col3\", then data rows the same way, closed with \"[/table]\". Max 6 data rows, 4 columns.";
  const system: AnthropicContentBlock[] = [
    // Корпус = вбудовані доки + користувацький шар (нотатки/заміни з `knowledge_docs`).
    // Блок лишається СТАБІЛЬНИМ між викликами (детермінований порядок), тож prompt-cache
    // працює як раніше; текст міняється лише коли користувач сам відредагував документ.
    { type: "text", text: (await buildKnowledgeCorpus(env.DB)) + "\n\n---\n\n" + stableRules, cache_control: { type: "ephemeral", ttl: "1h" } },
    {
      type: "text",
      text:
        toolNote +
        "Here is the user's full financial context (amounts in WHOLE units of the display currency): " + JSON.stringify(context) +
        ". Rely ONLY on this data; if something needed is missing, say so honestly rather than inventing " +
        "transactions or numbers." +
        // The requested SHAPE of the answer must match the output budget it will be given. A demo
        // is clamped to 900 output tokens (`demoClamp`) with continuation disabled, so asking for
        // the four-part structured answer above guarantees a reply that stops mid-sentence — which
        // reads as the app breaking, not as a demo limit ("обрізає відповідь"). It overrides here,
        // in the dynamic block, rather than in `stableRules`: that block is byte-identical across
        // calls AND users so the 1h prompt cache holds, and a demo branch inside it would split
        // the cache in two for the sake of one paragraph.
        (demo
          ? " ⚠️ THIS IS A DEMO SANDBOX with a hard output limit, and it OVERRIDES the instruction above about " +
            "answering in detail. Keep every answer SHORT — at most about 120 words: a one-sentence conclusion, the " +
            "two or three numbers that matter, and at most two concrete steps. Never open a list you cannot finish, " +
            "and never use charts or tables here. A complete short answer is required; a detailed one would be cut " +
            "off mid-sentence."
          : ""),
    },
    // Language gets its OWN final block instead of being the tail of the previous one, where it
    // sat behind several kilobytes of JSON context — the weakest position in the whole system
    // prompt, with Ukrainian prose on every side of it. Last block is the only place where
    // "answer in this language" reads as an instruction rather than as the end of a data string.
    { type: "text", text: ((await replyLangDirective(env, "conversation")) + (await moneyUnitDirective(env))).trim() },
  ];
  const model = await getTaskModel(env, "chat");
  // §AGENT: якщо передано інструменти — ведемо агентний діалог; інакше звичайний виклик.
  if (opts?.tools?.length && opts.executor) {
    // §A3: додаємо серверний web_search (варіант за моделлю) — актуальні курси/тарифи/ціни.
    const serverTools = demo ? [] : [webSearchTool(model)];
    // Each turn is a separate billed request AND a separate `demoAiGate` hit, so a demo sandbox
    // gets a shorter loop: 6 turns of one question could eat half its whole session allowance.
    const maxTurns = demo ? 3 : 6;
    const { text, usage } = await runToolConversation(env, system, messages, opts.tools, opts.executor, CHAT_MAX_OUTPUT, model, maxTurns, serverTools, opts.onText);
    return { text: text.trim(), usage };
  }
  // §R6/§CTX: детальні відповіді менеджера — більший ліміт виводу.
  const { text, usage } = await callHaikuMessages(env, system, messages, CHAT_MAX_OUTPUT, model, opts?.onText);
  return { text: text.trim(), usage };
}


// Інлайн-чат по КОНКРЕТНІЙ операції: людяна відповідь + опційне оновлення розуміння
// (категорія / прапорець переказу). Модель міняє категорію лише за чіткої підстави з розмови.
export interface TxChatResult {
  reply: string;                 // 1-3 речення живою мовою (можна легкий markdown)
  category_id?: number | null;   // id з переліку — ЛИШЕ якщо треба змінити категорію
  is_transfer?: boolean;         // true, якщо стало ясно, що це переказ між своїми
  understanding?: string | null; // оновлений короткий здогад «що це»
}

export async function txChat(
  env: Env,
  ctx: unknown,
  messages: ChatMsg[],
): Promise<{ result: TxChatResult; usage: AnthropicUsage }> {
  const base = await buildSystemPrefix(
    env,
    "this is the user talking about ONE SPECIFIC bank operation (its context is below). Help them understand or " +
      "clarify it, and answer briefly. If the user states outright WHAT it was (\"that was leisure\", \"that was " +
      "groceries\", \"move it back to cafés\"), or the conversation makes it unambiguous, update the category — " +
      // Categories are named by MEANING, not by their seeded label: the taxonomy above arrives in
      // the reader's own language now, so «Розваги» would be a name the model cannot find there.
      "matching by meaning, not by exact wording (leisure or fun → the entertainment category, food → the groceries " +
      "category, and so on). Answer with VALID JSON ONLY: {reply (1-3 sentences, **bold** allowed), category_id (the " +
      "id of the main category from the list — ONLY if it needs changing, otherwise omit the field), is_transfer " +
      "(true if it became clear this is a transfer between the user's own accounts, otherwise omit the field), " +
      "understanding (an updated short guess at what this is, or null)}. Do NOT change the category without clear " +
      "grounds from the conversation. The context carries user_note (the user's own note on the operation) and " +
      "user_profile (a description of the user) — you MUST take them into account: if the user already explained " +
      "what this is, build on that instead of ignoring it. " +
      "If this is INCOME and the user says it is their salary, earnings or a withdrawal of their own money (e.g. " +
      "moving a crypto salary out via a person-to-person transfer), put it in the salary category (or the income " +
      "category they named) and describe the understanding that way; do NOT call it a gift or write \"transfer from " +
      "a private individual\" when the user has explicitly said otherwise.",
  );
  const system: AnthropicContentBlock[] = [
    ...base,
    // This inline chat had NO language directive at all (found while fixing B6) — its prose
    // answer simply inherited the Ukrainian prompt regardless of who was reading.
    { type: "text", text: "Operation context (amounts in its own currency): " + JSON.stringify(ctx) + (await replyLangDirective(env, "conversation")) + (await moneyUnitDirective(env)) },
  ];
  return callHaikuMessagesJson<TxChatResult>(env, system, messages, 700, await getTaskModel(env, "chat"));
}





// §3: діалог про бюджети — AI пропонує/коригує ліміти в розмові й пояснює ЧОМУ.
export interface BudgetChatResult {
  reply: string;
  proposals?: { category_id: number; limit_uah: number; reason: string }[];
}
export async function budgetChat(
  env: Env,
  ctx: unknown,
  messages: ChatMsg[],
): Promise<{ result: BudgetChatResult; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "You are a budgeting assistant. Hold a conversation about MONTHLY envelope budgets per category. " +
        "The context below carries categories:[{id,name,avg_month_uah,current_limit_uah,importance}], own_funds_uah, " +
        "monthly_burn_uah, situation. Advise REALISTIC limits based on avg_month_uah and importance: do not cut " +
        "essential ones sharply; optional ones can be squeezed harder. Explain WHY that particular figure. " +
        "When you propose concrete limits, put them in proposals so the user can accept them in one tap. " +
        "Answer with VALID JSON ONLY: {reply (2-5 sentences, **bold** allowed), " +
        "proposals:[{category_id (only from the list), limit_uah (a whole number of the display currency), reason (briefly why)}] " +
        "(an empty array if this is just an answer with no new limit proposals)}." +
        (await replyLangDirective(env, "conversation")) + (await moneyUnitDirective(env)),
    },
    { type: "text", text: "Context: " + JSON.stringify(ctx) },
  ];
  return callHaikuMessagesJson<BudgetChatResult>(env, system, messages, 1400, await getTaskModel(env, "budget"));
}
