/**
 * L6 — the chat's TOOLS: the model's own read access to the full operation database.
 *
 * Split out of `advisor.ts` (2026-08-08) when the C3 size check refused to let that file grow
 * again. The seam is a real one rather than a line count: everything else in `advisor.ts` builds a
 * context and hands it to a model, while this file is a small query API the model calls back into.
 * The tool schema and the executor also have to agree field by field, and keeping them adjacent is
 * what makes a mismatch visible.
 *
 * Domain logic lives here; the tool-use transport is `ai.ts` (`runToolConversation`).
 *
 * ⚠️ Both halves speak the READER's language — see the note on `resolveLocale` inside
 * `runFinanceTool`. A filter in one language against names stored in another silently returns
 * nothing, which the model then reports as "you have no such spending".
 */
import type { Env } from "../../env.ts";
import type { ChatTool } from "./ai.ts";
import { getRates } from "../finance/money.ts";
import { resolveLocale } from "../platform/i18n.ts";
import { catNameSql } from "../finance/categories-i18n.ts";
import { addFact } from "./facts.ts";
import {
  STATS_JOINS, EFF_CAT_ID, EFF_CAT_NAME, SPEND_WHERE, INCOME_WHERE, valueMode, amountSum,
} from "../finance/stats.ts";
import { localWallTime, localYmd, localYmSql } from "../finance/time.ts";

/** Unix seconds for a YYYY-MM-DD string, or null. `endOfDay` pushes it to 23:59:59. */
/**
 * Which of the tools above only READ.
 *
 * Named here, beside the tools themselves, because it is a property of each tool rather than of
 * whoever is calling it — a second surface that had to remember "and skip remember_fact" would
 * forget it the first time a tool was added. `financeReadTools()` is what the MCP server exposes
 * (`routes/mcp.ts`): a credential sitting in an editor's config file gets to look at the ledger,
 * not to write proposals into it that later move burn and runway.
 */
const READ_ONLY = new Set(["query_spend", "find_transactions", "list_categories"]);

/** The read-only subset, for callers that are not the in-app chat. */
export function financeReadTools(): ChatTool[] {
  return financeChatTools().filter((t) => READ_ONLY.has(t.name));
}

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY.has(name);
}

/**
 * Make one tool schema STRICT — explicitly, and for every client (2026-09-02).
 *
 * These schemas were written against Anthropic, which is forgiving: an absent `required` means
 * "nothing is required" and an absent `additionalProperties` means "anything goes". Other clients
 * validate JSON Schema harder before they will show a tool at all, and the failure mode is the
 * quietest one there is — a schema a client rejects means, to that client, that the tool DOES NOT
 * EXIST. No error surfaces anywhere; the assistant simply answers as though it has no access to
 * the ledger.
 *
 * Two additions, both safe for every client:
 *   · `required` is always present, even as `[]` — the difference between "no required fields" and
 *     "the field is missing from the schema" is exactly what a strict validator objects to;
 *   · `additionalProperties: false` — the executor ignores unknown keys anyway, so this states a
 *     rule that already held, and it makes a model that invents a parameter fail loudly at the
 *     schema instead of quietly having it dropped.
 *
 * ⚠️ It does NOT list every property in `required` (OpenAI's *strict* function-calling mode wants
 * that). Doing so would make genuinely optional filters mandatory for EVERY client, including the
 * in-app chat — a much bigger behavioural change than the compatibility it buys, and the wrong
 * trade to make blind.
 */
function strict(schema: Record<string, unknown>): Record<string, unknown> {
  return { ...schema, required: schema.required ?? [], additionalProperties: false };
}

export function financeChatTools(): ChatTool[] {
  const dateProp = { type: "string", description: "A date in YYYY-MM-DD format" };
  const tools: ChatTool[] = [
    {
      name: "query_spend",
      description: "Compute the user's total spending or income over a period (in WHOLE units of the display currency, converted at the stored rate), optionally filtered by category or merchant and grouped. For questions like \"how much did I spend or earn on X during Y\".",
      input_schema: {
        type: "object",
        properties: {
          from_date: { ...dateProp, description: "Start of the period (inclusive), YYYY-MM-DD" },
          to_date: { ...dateProp, description: "End of the period (inclusive), YYYY-MM-DD" },
          flow: { type: "string", enum: ["spend", "income"], description: "Spending or income. Defaults to spend." },
          category: { type: "string", description: "Category name, partial match (e.g. \"Taxi\"). Optional." },
          merchant: { type: "string", description: "Merchant name, partial match (e.g. \"Uklon\"). Optional." },
          group_by: { type: "string", enum: ["none", "month", "category", "merchant"], description: "Grouping. Defaults to none." },
        },
        required: ["from_date", "to_date"],
      },
    },
    {
      name: "find_transactions",
      description: "Find individual operations by filter (returns id, date, merchant, amount in whole currency units, category). Use it when you need to show example operations rather than just a total. An id can be cited as [tx:ID|caption].",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text in the merchant name or comment. Optional." },
          from_date: { ...dateProp, description: "From this date (inclusive). Optional." },
          to_date: { ...dateProp, description: "To this date (inclusive). Optional." },
          category: { type: "string", description: "Category name, partial match. Optional." },
          flow: { type: "string", enum: ["spend", "income", "any"], description: "Defaults to any." },
          min_amount_uah: { type: "number", description: "Minimum absolute amount, in whole currency units (500 means 500, not 50000). Optional." },
          limit: { type: "number", description: "How many to return (1-25, default 12)." },
        },
      },
    },
    {
      name: "list_categories",
      description: "The user's category list (top-level names), so you know what values to filter by. Call it when you are unsure of a category's exact name.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "remember_fact",
      description:
        "Remember a FACT about the world that the user told you (e.g. \"from 15.07 the metro costs 30 UAH instead of 8\", \"I left my job\", \"the rent went up to 12500\"). The fact is stored as a PROPOSAL — it is not applied to any number until the user taps apply themselves. " +
        "If the fact affects a category's monthly spending, FIRST work the effect out deterministically via " +
        "find_transactions/query_spend (e.g. how many metro rides per month the history shows × the price " +
        "difference), then pass monthly_delta_uah OR multiplier. Do NOT invent the figure. " +
        "Global facts with no effect on an amount (leaving a job, moving house) are passed with text only (no " +
        "category, no adjustment). After the call, tell the user your estimate of the effect and that applying it " +
        "needs their confirmation.",
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string", description: "A short description of the fact in plain language, e.g. \"The metro fare rose from 8 to 30 UAH\"." },
          category: { type: "string", description: "The category the amount adjustment applies to (partial match, e.g. \"Transport\"). Omit for a global fact." },
          effective_from: { ...dateProp, description: "The date the fact takes effect (YYYY-MM-DD). Defaults to today." },
          expires_at: { ...dateProp, description: "The date it stops applying (YYYY-MM-DD). Omit if open-ended." },
          monthly_delta_uah: { type: "number", description: "How many UAH per month the category's spending changes by (+ dearer, − cheaper). Work it out from history. Mutually exclusive with multiplier." },
          multiplier: { type: "number", description: "The factor by which the category level rises or falls (e.g. 3.75 for 8→30). Mutually exclusive with monthly_delta_uah." },
        },
        required: ["text"],
      },
    },
  ];
  return tools.map((t) => ({ ...t, input_schema: strict(t.input_schema) }));
}

function parseToolDate(s: unknown, endOfDay = false): number | null {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  // §APP_TZ (2026-08-21): a bare date from the model is a KYIV wall clock, not UTC — the same
  // rule §BANK-PARSE states for a statement. With `Date.UTC` the boundary sat at 03:00 Kyiv, so
  // "spending in August" quietly dropped the first three hours of the 1st and swallowed the last
  // three of July. The model then reported a total the screen disagreed with, confidently.
  const at = localWallTime(
    Number(m[1]), Number(m[2]), Number(m[3]),
    endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0,
  );
  return Number.isFinite(at) ? at : null;
}
const isoDay = (unix: number) => localYmd(unix);

export async function runFinanceTool(env: Env, name: string, input: Record<string, unknown>): Promise<unknown> {
  const rates = await getRates(env);
  // §BASE-CUR: `getRates` answers in the READER's base, so `valueMode(rates, null)` rolls up into
  // that base — not into hryvnia. The comment here used to say «завжди ₴», which was true before
  // the display currency existed and is the reason the `currency` field below was wrong.
  const { mult } = valueMode(rates, null);
  const { currencyCode } = await import("../../../shared/currency.ts");
  const { resolveBaseCurrency } = await import("../finance/money.ts");
  /**
   * The unit the tool ANSWERS in, stated to the model as a fact.
   *
   * ⚠️ It was the literal `"UAH"`, and that is worse than the `_uah` suffix the money directive
   * already explains away. The suffix is a key name the prompt can (and does) tell the model to
   * disregard; this is a positive claim in the DATA, and a model handed a general instruction and
   * a specific contradicting field will believe the field. So a dollar reader asking «скільки на
   * продукти» got a correct number labelled with the wrong currency, by the tool, in writing.
   */
  const currency = currencyCode(await resolveBaseCurrency(env));
  /**
   * The tools speak the same language the model was shown — in BOTH directions.
   *
   * The output half is obvious (a tool that answers «Продукти» to an English conversation makes
   * the answer bilingual). The FILTER half is the one that silently returns nothing: the model can
   * only name a category it has seen, so on an English screen it filters for "Groceries" — and
   * `EFF_CAT_NAME LIKE '%Groceries%'` matches no stored row, because the stored name is Ukrainian.
   * The model then reports, truthfully and uselessly, that there is no such spending.
   */
  const loc = await resolveLocale(env);
  const CAT_NAME = catNameSql(loc, EFF_CAT_NAME);

  if (name === "query_spend") {
    const from = parseToolDate(input.from_date);
    const to = parseToolDate(input.to_date, true);
    if (from == null || to == null) return { error: "from_date and to_date must be in YYYY-MM-DD format" };
    const flow = input.flow === "income" ? "income" : "spend";
    const whereFlow = flow === "income" ? INCOME_WHERE : SPEND_WHERE;
    const sumExpr = flow === "income"
      ? `CAST(ROUND(COALESCE(SUM(t.amount * ${mult}), 0)) AS INTEGER)`
      : amountSum(mult);
    const binds: unknown[] = [from, to];
    const extra: string[] = [];
    if (typeof input.category === "string" && input.category.trim()) { extra.push(`${CAT_NAME} LIKE ?`); binds.push(`%${input.category.trim()}%`); }
    if (typeof input.merchant === "string" && input.merchant.trim()) { extra.push("t.merchant LIKE ?"); binds.push(`%${input.merchant.trim()}%`); }
    const where = `t.time >= ? AND t.time <= ? AND ${whereFlow}${extra.length ? ` AND ${extra.join(" AND ")}` : ""}`;
    const group = input.group_by;
    if (group === "month" || group === "category" || group === "merchant") {
      // The month bucket is APP_TZ, like every other month key in the app. A raw `strftime` here
      // meant the model grouped months differently from the screen it is answering about.
      const sel = group === "month" ? localYmSql(to) : group === "category" ? CAT_NAME : "COALESCE(t.merchant, 'other')";
      const grp = group === "category" ? EFF_CAT_ID : sel;
      const order = group === "month" ? "label ASC" : "amt DESC";
      const rows = await env.DB.prepare(
        `SELECT ${sel} AS label, ${sumExpr} AS amt, COUNT(DISTINCT t.id) AS n FROM transactions t ${STATS_JOINS} WHERE ${where} GROUP BY ${grp} ORDER BY ${order} LIMIT 24`,
      ).bind(...binds).all<{ label: string; amt: number; n: number }>();
      return { flow, from_date: input.from_date, to_date: input.to_date, currency, groups: (rows.results ?? []).map((r) => ({ label: r.label, amount_uah: Math.round(r.amt / 100), count: r.n })) };
    }
    const tot = await env.DB.prepare(
      `SELECT ${sumExpr} AS amt, COUNT(DISTINCT t.id) AS n FROM transactions t ${STATS_JOINS} WHERE ${where}`,
    ).bind(...binds).first<{ amt: number; n: number }>();
    return { flow, from_date: input.from_date, to_date: input.to_date, currency, total_uah: Math.round((tot?.amt ?? 0) / 100), count: tot?.n ?? 0 };
  }

  if (name === "find_transactions") {
    const from = parseToolDate(input.from_date);
    const to = parseToolDate(input.to_date, true);
    const parts = ["t.transfer_pair_id IS NULL"];
    const binds: unknown[] = [];
    if (from != null) { parts.push("t.time >= ?"); binds.push(from); }
    if (to != null) { parts.push("t.time <= ?"); binds.push(to); }
    if (input.flow === "spend") parts.push("t.amount < 0");
    else if (input.flow === "income") parts.push("t.amount > 0");
    if (typeof input.category === "string" && input.category.trim()) { parts.push(`${CAT_NAME} LIKE ?`); binds.push(`%${input.category.trim()}%`); }
    if (typeof input.query === "string" && input.query.trim()) { const q = `%${input.query.trim()}%`; parts.push("(t.merchant LIKE ? OR t.comment LIKE ?)"); binds.push(q, q); }
    if (typeof input.min_amount_uah === "number" && input.min_amount_uah > 0) { parts.push(`ABS(t.amount * ${mult}) >= ?`); binds.push(Math.round(input.min_amount_uah * 100)); }
    const limit = Math.min(Math.max(Math.trunc(Number(input.limit) || 12), 1), 25);
    const rows = await env.DB.prepare(
      `SELECT t.id AS id, t.time AS time, t.merchant AS merchant, t.comment AS comment,
              CAST(ROUND(t.amount * ${mult}) AS INTEGER) AS amt, ${CAT_NAME} AS cat
       FROM transactions t ${STATS_JOINS} WHERE ${parts.join(" AND ")} ORDER BY t.time DESC LIMIT ?`,
    ).bind(...binds, limit).all<{ id: string; time: number; merchant: string | null; comment: string | null; amt: number; cat: string | null }>();
    return {
      count: rows.results?.length ?? 0,
      transactions: (rows.results ?? []).map((r) => ({
        id: r.id, date: isoDay(r.time), merchant: r.merchant || r.comment || "operation",
        amount_uah: Math.round(r.amt / 100), category: r.cat || "uncategorised",
      })),
    };
  }

  if (name === "list_categories") {
    const rows = await env.DB.prepare(
      `SELECT ${catNameSql(loc, "name")} AS name FROM categories WHERE parent_id IS NULL AND id <> 13 ORDER BY name`,
    ).all<{ name: string }>();
    return { categories: (rows.results ?? []).map((r) => r.name) };
  }

  if (name === "remember_fact") {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) return { error: "the fact's text is required" };
    const now = Math.floor(Date.now() / 1000);
    const ef = parseToolDate(input.effective_from) ?? now;
    const ex = parseToolDate(input.expires_at, true); // null = безстроково
    let categoryId: number | null = null;
    if (typeof input.category === "string" && input.category.trim()) {
      const cat = await env.DB.prepare(
        `SELECT id FROM categories WHERE parent_id IS NULL AND ${catNameSql(loc, "name")} LIKE ? ORDER BY name LIMIT 1`,
      ).bind(`%${input.category.trim()}%`).first<{ id: number }>();
      if (!cat) return { error: `category "${input.category}" was not found — call list_categories and use an exact name`, needs_category: true };
      categoryId = cat.id;
    }
    // Коригування числа лише коли є категорія (глобальний факт = лише наратив).
    let adjustKind: "multiplier" | "delta_minor" | null = null;
    let adjustValue: number | null = null;
    if (categoryId != null) {
      if (typeof input.multiplier === "number" && input.multiplier > 0) { adjustKind = "multiplier"; adjustValue = input.multiplier; }
      else if (typeof input.monthly_delta_uah === "number" && input.monthly_delta_uah !== 0) { adjustKind = "delta_minor"; adjustValue = Math.round(input.monthly_delta_uah * 100); }
    }
    /**
     * Stored through `addFact`, not through an `INSERT` of our own.
     *
     * The two writers had the same column list and different defaults, and a column added to one
     * would have been missing from the other with nothing to notice. What is genuinely different
     * about this path is stated as arguments: the model AUTHORED this fact (`ai_proposed`) and
     * therefore may not confirm it (`confirm: false`) — a guess must not move burn or runway on
     * its own. The `note` below tells the user exactly that.
     */
    const res = await addFact(env, {
      text, effective_from: ef, expires_at: ex, category_id: categoryId,
      adjust_kind: adjustKind, adjust_value: adjustValue,
      source: "ai_proposed", confirm: false,
    });
    return {
      saved: true,
      fact_id: res.id,
      needs_confirmation: adjustKind != null,
      text, category_id: categoryId, adjust_kind: adjustKind, adjust_value: adjustValue,
      note: adjustKind
        ? "The fact was saved as a PROPOSAL. The numbers (avg_month/burn/runway) will NOT change until the user taps apply in the facts list. Tell the user that, and give your estimate of the effect."
        : "The fact was saved (explanatory only, with no amount adjustment).",
    };
  }

  return { error: `unknown tool: ${name}` };
}

