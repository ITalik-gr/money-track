/**
 * §CSV-AI — reading the SHAPE of a statement the hint table could not recognise.
 *
 * The deterministic guesser (`providers/csv.ts` `guessMapping` + `findHeaderRow`) matches header
 * text against a list of spellings we have seen. It handles the banks we have met and fails
 * silently on the next one: the preview says "map these columns yourself", which is a form asking
 * a person to do the one thing the app was supposed to do for them. Asked for by the owner:
 * «щоб воно автоматично розуміло що є що, можливо аі юзати навіть якщо кодом не розібраться легко».
 *
 * ⚠️ **A FALLBACK, never the default path.** It runs only when the three mandatory columns cannot
 * be found by rule. A bank we already recognise must not start costing a model call, and — the
 * larger reason — the deterministic path is reproducible: the same file maps the same way today
 * and in a year, which a model does not promise.
 *
 * ⚠️ **The model names COLUMNS, never values.** It returns indices; every number and date is then
 * read by §BANK-PARSE exactly as on the deterministic path. A model that returned parsed amounts
 * would be a second parser, silently disagreeing with the first about rounding, thousand
 * separators and time zones — §CUR-PLAN in a new costume.
 *
 * ⚠️ **Its answer is PROVEN before use** (`mappingParsesSample`). The prompt asking for a valid
 * mapping is a request; the check that the proposed date column actually parses as dates and the
 * amount column as amounts is what makes a wrong answer harmless. Same rule as `numbersAreGrounded`
 * and the SQL lint: if correctness depends on the model obeying, verify it in code.
 *
 * ⚠️ **The result is still shown for confirmation.** The preview is not skipped and the UI says the
 * mapping came from AI — a guess that hides that it is a guess is the thing that gets trusted.
 */
import type { Env } from "../../env.ts";
import { callHaikuJson } from "./json.ts";
import type { AnthropicUsage } from "./cost.ts";
import { logUsage } from "./cost.ts";
import { parseAmountMinor, parseStatementDate } from "../bank/normalize.ts";
import type { AnthropicContentBlock } from "./ai.ts";

/** Column indices into the header row, plus which row the model believes the header is. */
export interface StatementMapping {
  header_row: number | null;
  date: number | null;
  amount: number | null;
  description: number | null;
  currency: number | null;
  comment: number | null;
  mcc: number | null;
}

/** How many rows of the file the model is shown. Enough to tell a header from a preamble. */
export const SAMPLE_ROWS = 15;
/** How many body rows must parse for a proposed mapping to be believed. */
const MIN_PROVEN_ROWS = 2;

/**
 * Does this mapping actually READ the file?
 *
 * Deliberately strict about the two columns whose failure is invisible: a wrong date column files
 * a year of spending under today, and a wrong amount column imports plausible nonsense. The
 * description is not checked — a blank description is a poor import, not a wrong one.
 */
export function mappingParsesSample(rows: string[][], m: StatementMapping): boolean {
  if (m.date == null || m.amount == null || m.description == null) return false;
  const start = (m.header_row ?? 0) + 1;
  let ok = 0;
  for (const row of rows.slice(start)) {
    if (parseStatementDate(row[m.date] ?? "") == null) continue;
    const amount = parseAmountMinor(row[m.amount] ?? "");
    if (amount == null || amount === 0) continue;
    ok++;
  }
  return ok >= MIN_PROVEN_ROWS;
}

/** Indices must exist in the file, or the mapping reads columns that are not there. */
function withinBounds(m: StatementMapping, width: number): boolean {
  const cols = [m.date, m.amount, m.description, m.currency, m.comment, m.mcc];
  return cols.every((c) => c == null || (Number.isInteger(c) && c >= 0 && c < width));
}

/**
 * Ask the model which column is which. Returns `null` when it declined, failed, or proposed a
 * mapping that does not read the file — every one of which leaves the user exactly where the
 * deterministic path left them, which is a working manual form rather than a broken import.
 */
export async function mapStatementColumns(
  env: Env,
  rows: string[][],
): Promise<{ mapping: StatementMapping; usage: AnthropicUsage } | null> {
  const sample = rows.slice(0, SAMPLE_ROWS);
  if (!sample.length) return null;
  const width = Math.max(...sample.map((r) => r.length));

  const system: AnthropicContentBlock[] = [{
    type: "text",
    text:
      "You read BANK STATEMENT files. You are given the first rows of one, already split into " +
      "cells. Answer with VALID JSON ONLY — no explanation, no markdown fence.\n\n" +
      "Return {header_row, date, amount, description, currency, comment, mcc}. Every value is a " +
      "ZERO-BASED index, or null when the file has no such column.\n" +
      "- header_row: the row that holds the column TITLES. A statement usually opens with a " +
      "preamble — the bank's details, the account holder, the period, the totals — and the table " +
      "starts below it. If the very first row is already the titles, answer 0.\n" +
      "- date: when the operation happened. Prefer the transaction date over a posting or " +
      "value date when both are present.\n" +
      "- amount: the signed amount in the currency of the ACCOUNT (a card-currency column beats " +
      "a transaction-currency one). If debits and credits are two separate columns, answer with " +
      "the debit one — a split pair is not supported and a wrong single column is worse than " +
      "none, so in that case answer null.\n" +
      "- description: what the money was spent on — the merchant, the counterparty, the purpose.\n" +
      "- currency, comment, mcc: optional; null unless clearly present.\n\n" +
      "⚠️ You name COLUMNS, never values. Do not parse, convert or restate any amount or date.\n" +
      "⚠️ If you cannot tell which column is which, answer null for it rather than guessing. A " +
      "wrong column imports a year of wrong numbers that look completely ordinary; a null one " +
      "simply asks the person.",
  }];

  const user = [{
    type: "text" as const,
    text: JSON.stringify({ column_count: width, rows: sample }),
  }];

  try {
    const { result, usage } = await callHaikuJson<StatementMapping>(
      env, system, user, 300, undefined,
      (r) => (r && typeof r === "object" && "date" in r ? null : "return the JSON object described above"),
    );
    logUsage("statement-map", usage);
    const mapping: StatementMapping = {
      header_row: num(result?.header_row), date: num(result?.date), amount: num(result?.amount),
      description: num(result?.description), currency: num(result?.currency),
      comment: num(result?.comment), mcc: num(result?.mcc),
    };
    if (!withinBounds(mapping, width)) return null;
    if (!mappingParsesSample(sample, mapping)) return null;
    return { mapping, usage };
  } catch {
    // A model that is unavailable, rate-limited or without a key must not fail the PREVIEW: the
    // manual mapping form is still there and still works. This path exists to save typing, and a
    // saving that can break the feature it assists is not one.
    return null;
  }
}

/** A model may answer with a string index, a float, or a word. Only a whole number is an index. */
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}
