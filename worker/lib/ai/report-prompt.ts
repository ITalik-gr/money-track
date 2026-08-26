/**
 * The report's PROMPT and the single call that uses it.
 *
 * Split from `report.ts` on 2026-08-12, when lint C3 refused that file another line. The seam is
 * real and not just a line count: `report.ts` assembles the canonical context and stores the
 * result — database work — while everything here is one instruction to a model plus the shape it
 * must answer in. The prompt is also the part that changes for reasons that have nothing to do
 * with the data (§NOVELTY, §CADENCE, the length floor), so it earns its own file to change in.
 *
 * ⚠️ English, once, like every prompt in `lib/ai` (§LANG-ARCH). The reply language is NOT named
 * here — that is `replyLangDirective`'s only job, appended as its own final block.
 */
import type { Env } from "../../env.ts";
import { callHaikuJson } from "./json.ts";
import { replyLangDirective, moneyUnitDirective } from "./prompt.ts";
import { getTaskModel } from "./models.ts";
import type { AnthropicContentBlock } from "./ai.ts";
import type { AdviceAction } from "./generate.ts";
import type { AnthropicUsage } from "./cost.ts";

export interface FinancialReport {
  headline: string;                 // 1 рядок — головне за період
  summary: string;                  // 2-4 речення — стан і висновок
  sections: { title: string; body: string }[];              // 2-4 наративні секції
  category_breakdown: { name: string; amount_uah: number; delta_pct: number | null; note: string | null }[];
  anomalies: { label: string; detail: string; severity: "info" | "warn" | "high" }[];
  predictions: { next_period_spend_uah: number | null; runway_months: number | null; note: string | null };
  advice: { title: string; detail: string; action?: AdviceAction | null }[];
}

export async function generateFinancialReport(
  env: Env,
  payload: unknown,
): Promise<{ result: FinancialReport; usage: AnthropicUsage }> {
  const system: AnthropicContentBlock[] = [
    {
      type: "text",
      text:
        "You are a senior personal financial analyst. Build a DETAILED periodic report from the user's CANONICAL " +
        "data supplied below (all amounts already converted into WHOLE units of the display currency; period describes the type and the bounds). " +
        "The data has already been computed correctly (cash counted by its real category, transfers between the " +
        "user's own accounts excluded, currencies converted to UAH) — USE these numbers, do not recompute and do not " +
        "invent. The payload carries: current (spend/income/net/savings_rate), previous (the same preceding period, " +
        "for a fair comparison), categories (with delta_pct against the previous one), top_merchants, notable " +
        "(noteworthy operations with the user's own user_note — take them into account so you do not call a one-off " +
        "recurring), anomalies_hint (hints about subscription price rises and outliers), forecast (projection and " +
        "runway), by_importance (share of spending by importance: essential, discretionary, optional — aim advice " +
        "about cutting at optional and discretionary, and never advise cutting essential). " +
        "IMPORTANT (not \"by the book\"): respect user_profile — it is the person's real situation; if there is no " +
        "active income, do NOT recommend generalities like \"grow your income\" or \"invest\" — focus on runway and " +
        "on trimming optional/discretionary. " +
        "recurring_vs_oneoff separates the usual monthly rhythm (recurring) from one-off spikes (oneoff: taxes, " +
        "dentist, a large purchase) — do NOT project one-offs into the next period and do NOT call them a trend. " +
        "Base forecasts on the real CUSHION (forecast.cushion_uah — positive own funds), NOT on a net figure that " +
        "includes the credit card; mention debt (forecast.debt_uah) separately. " +
        "forecast.investment_reserve_uah (crypto, brokerage) is NOT the liquid cushion and NOT part of runway; it is " +
        "a separate last line, so do not propose selling investments without dire need. accounts lists accounts with " +
        "their role and DESCRIPTION (note): treat note as context. " +
        // ⚠️ Явні мінімуми, бо без них модель вивалювала ВЕСЬ звіт в один абзац `summary`, а
        // `sections`/`predictions`/`advice` лишала порожніми — валідний JSON і порожній екран.
        // Перевірка в коді (`validate` нижче) ловить це й перепитує; тут — щоб не доводилось.
        "🔴 YOU MUST FILL EVERY FIELD. `summary` is a 2-4 sentence overview, NOT the place for the whole report: " +
        "detail goes in `sections` (2-4 sections), the projection in `predictions`, advice in `advice` (3-5 items), " +
        "top categories in `category_breakdown`. A report consisting of summary alone counts as an error and will " +
        "be rejected. " +
        // §CADENCE — без цього блоку модель порівнювала МІСЯЧНІ платежі тиждень-до-тижня й видавала
        // «підписки впали з 1300₴ до 99₴ (−92%)», хоча це той самий календар: одне списання потрапило
        // у вікно, друге — ні. Прапорці рахує report.ts (детерміновано), тут — що з ними робити.
        "🔴 CHARGE CADENCE. categories carry charges_n / prev_charges_n (how many charges produced the sum), " +
        "monthly_usual_uah (the canonical MONTHLY level of the category) and billing: 'monthly_fixed' = charged once " +
        "a month (subscription, rent, insurance), 'variable' = many small purchases. When delta_meaningful=false, " +
        "delta_pct reflects the TIMING of a charge rather than a change in behaviour, and presenting it as a trend " +
        "is FORBIDDEN. Instead of \"subscriptions fell 92%\", write \"no monthly charge landed this week; the usual " +
        "level is monthly_usual_uah\". Likewise income_delta_meaningful=false means the salary or invoice arrived in " +
        "a different week, NOT that income disappeared — build neither a conclusion nor a forecast on it. " +
        "For periods shorter than a month, compare spending against monthly_usual_uah, not against previous alone. " +
        // §NOVELTY — the biggest category is biggest every week, so the model kept "discovering" it.
        "🔴 NOVELTY. already_covered holds the observations, anomalies and advice from YOUR previous reports. Do NOT " +
        "present them as news a second time: if the situation has not changed, give at most one \"unchanged\" phrase " +
        "and move on. " +
        // 2026-08-12 ("reports have gone small"): novelty and LENGTH were read as one instruction.
        "⚠️ Novelty governs WHAT you write, never HOW MUCH: every section, the projection and 3-5 advice items are " +
        "required even in an uneventful period — the value moves to the numbers and the trajectory, not to finding " +
        "a new headline. The largest category is not in itself an observation (\"rent is the largest\" is true every " +
        "month and adds nothing); an observation is what CHANGED, or what the person cannot see from the table " +
        "itself. prior_reports holds your earlier reports: check the trajectory and note what improved or worsened " +
        "since. " +
        "notable and biggest_expenses carry a tx_id field — when you mention a SPECIFIC operation in the text " +
        "(summary/sections/anomalies.detail/advice.detail), put the token [tx:ID] right after its name (e.g. " +
        "\"Rozetka [tx:abc123]\"), where ID is that operation's tx_id. Use ONLY ids that exist, never invented. Do " +
        "not overdo it — 1-2 citations where they are apt. " +
        "Write to the point, with concrete numbers and percentage changes. Answer with VALID JSON ONLY, no markdown: " +
        "{headline, summary, sections:[{title, body}] (2-4 sections — where the money went, what changed and why, " +
        "risks), category_breakdown:[{name, amount_uah, delta_pct (number or null), note}] (top 8 categories, note is " +
        "one phrase), anomalies:[{label, detail, severity ('info'|'warn'|'high')}] (unusual or one-off spending, " +
        "subscription price rises; empty array if none), predictions:{next_period_spend_uah (number or null), " +
        "runway_months (number or null), note}, advice:[{title, detail, action}] (3-5 actionable items with the " +
        "effect as an amount; action is null or {type:'create_budget', label, category_id, category_name, amount_uah})}. " +
        "Amounts are whole units of the display currency named below." +
        (await replyLangDirective(env)) + (await moneyUnitDirective(env)),
    },
  ];
  // 8000, а не 3000: повний звіт українською — це 2-4 секції, 8 категорій, аномалії та 3-5 порад,
  // і кирилиця коштує ~2-3 токени на слово. На 3000 модель стабільно обривалась приблизно на
  // `summary`, а ремонт JSON робив цей обрив невидимим (див. `callHaikuJson`).
  //
  // Валідатор — бо ліміту токенів виявилось мало: маючи 8000, модель однаково повертала лише
  // headline+summary, і на екрані зникали Прогноз, Розбір і Поради. Промт просить — код перевіряє.
  return callHaikuJson<FinancialReport>(
    env, system, [{ type: "text", text: JSON.stringify(payload) }], 8000, await getTaskModel(env, "report"),
    (r) => {
      const missing: string[] = [];
      if (!(r.sections?.length >= 2)) missing.push("the breakdown (sections, 2-4 of them)");
      if (!(r.advice?.length >= 3)) missing.push("advice (advice, 3-5 items)");
      if (!r.predictions) missing.push("the projection (predictions)");
      // `category_breakdown` — єдине з чотирьох, що має детермінований дублікат (ми рахуємо
      // категорії самі), тож його відсутність екран не ламає й на ретрай не тягне.
      return missing.length ? `required fields are missing: ${missing.join(", ")}.` : null;
    },
  );
}
