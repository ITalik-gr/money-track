// docs/JEV.md phase 4 — §CSV-AI: which column of an unknown bank statement is which field.
//
// The Claude prompt asked for a JSON object of indices and then had to be told, twice, not to guess
// («answer null for it rather than guessing»). Here every field is its own Choice over the file's
// real columns plus «none», so the answer can only ever be a column that exists or an honest
// «none» — and the header row is one more Choice over the first rows. The result then goes through
// the SAME `mappingParsesSample` proof as Claude's: a model's mapping is believed only when the
// file's own rows parse under it (§CSV-AI). Jev changes who proposes, not who checks.
//
// This is the one INTERACTIVE Jev call: a person is waiting on the import preview, which is where
// «seven questions for the latency of one» is felt rather than billed.
import type { Env } from "../../env.ts";
import { judge, judgeOn, type JudgeQuestion } from "./judge.ts";
import type { StatementMapping } from "./statement-map.ts";

const NONE = "none of these columns";

/** Below this, a field is left for the person — a wrong column imports a year of wrong numbers. */
const COLUMN_AT = 0.6;

/** The fields, with the same definitions the Claude prompt gives — one meaning per field. */
const FIELDS: Record<Exclude<keyof StatementMapping, "header_row">, string> = {
  date: "When the operation happened. Prefer the transaction date over a posting, booking or value date when both exist.",
  amount: "The signed amount in the currency of the ACCOUNT. A card-currency amount beats a transaction-currency one. If debits and credits are two separate columns, NO single column is the amount — answer none. A running balance is never the amount.",
  description: "What the money was for — the merchant, the purpose of the payment. When a file has both a purpose and a counterparty, the purpose is the description.",
  currency: "The currency code of the operation, if the file has such a column.",
  comment: "A free-text comment or note next to the description, if present.",
  mcc: "A four-digit merchant category code (MCC), if present.",
};

/** Option keys the model reads: the column's position AND its title, e.g. «col 3: Betrag». */
function columnKeys(header: string[], width: number): string[] {
  return Array.from({ length: width }, (_, i) => `col ${i}: ${(header[i] ?? "").trim() || "(untitled)"}`);
}

export async function judgeColumns(env: Env, sample: string[][], width: number): Promise<StatementMapping | null> {
  if (!judgeOn(env) || !sample.length) return null;
  try {
    // Round 1: which row is the header. Its answer decides the options of round 2 (the column
    // titles), so this is the documented case for a second request, not a speculative fan-out.
    const headerOpts = sample.slice(0, 10).map((r, i) => `row ${i}: ${r.join(" | ").slice(0, 120)}`);
    const first = await judge(env, { rows: sample }, {
      header: {
        type: "choice",
        instructions: "Which row of this bank statement holds the column TITLES? A statement often opens with a preamble — the bank, the account holder, the period — and the table starts below it.",
        criteria: Object.fromEntries(headerOpts.map((k) => [k, null])),
      },
    });
    const h = first.answers.header;
    if (h.type !== "choice") return null;
    const headerRow = headerOpts.indexOf(h.choice);
    if (headerRow < 0) return null;

    const keys = columnKeys(sample[headerRow] ?? [], width);
    const questions: Record<string, JudgeQuestion> = {};
    for (const [field, meaning] of Object.entries(FIELDS)) {
      questions[field] = {
        type: "choice",
        instructions: { question: `Which column of this statement is the ${field}?`, meaning },
        criteria: { ...Object.fromEntries(keys.map((k) => [k, null])), [NONE]: "The file has no such column" },
      };
    }
    const second = await judge(env, { header_row: headerRow, rows: sample }, questions);
    const pick = (field: string): number | null => {
      const a = second.answers[field];
      if (!a || a.type !== "choice" || a.choice === NONE) return null;
      if ((a.probabilities[a.choice] ?? 0) < COLUMN_AT) return null;
      const i = keys.indexOf(a.choice);
      return i >= 0 ? i : null;
    };
    return {
      header_row: headerRow,
      date: pick("date"), amount: pick("amount"), description: pick("description"),
      currency: pick("currency"), comment: pick("comment"), mcc: pick("mcc"),
    };
  } catch (e) {
    console.warn(`[jev] statement-map fell back to Claude: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
