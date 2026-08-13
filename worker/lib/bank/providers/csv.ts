// CSV import (PLATFORM.md §5, P1.2) — the cheapest possible multi-bank support: any bank that
// can export a statement is supported, without an API, a token or a partnership.
//
// Everything here fights the same enemy — a file is not a protocol. Ukrainian bank exports use
// `;` as often as `,`, write amounts as `-1 234,56` with a non-breaking space, and date formats
// differ per bank. Guessing wrong does not fail loudly; it silently produces a month of wrong
// numbers. So: the delimiter is detected, the mapping is GUESSED but shown to the user for
// confirmation, and every row is previewed before anything is written.
import type { AppDb } from "../../platform/db-shim.ts";
import { st, type ServerLocale } from "../../platform/i18n.ts";
import type { BankProvider, CanonicalTx } from "./provider.ts";
import { parseAmountMinor, parseStatementDate as parseDateUnix } from "../normalize.ts";

// ---- parsing ---------------------------------------------------------------------------

/**
 * Picks the delimiter by counting candidates in the header line.
 *
 * Counting on the header only, not the whole file: amounts and descriptions contain commas and
 * semicolons inside quotes, and those would outvote the real delimiter on a long statement.
 */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [";", ",", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const n = firstLine.split(d).length - 1;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** RFC 4180-style parse: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  // A BOM survives into the first header name and makes an exact header match fail — which
  // looks like "the mapping guesser is broken" rather than "there is an invisible character".
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Statement exports routinely end with blank lines and separator-only lines.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

// ---- value coercion --------------------------------------------------------------------
//
// Amount and date parsing moved to `lib/bank/normalize.ts` (BANKS.md §5, step 2): they are not
// CSV questions but BANK questions — PrivatBank hands us the same "1 234,56" and the same
// zone-less wall clock over an HTTP API. Re-exported here because the import route and its tests
// have always addressed them through this module.
export { parseAmountMinor, parseDateUnix };

// ---- column mapping --------------------------------------------------------------------

export interface ColumnMapping {
  date: number;
  amount: number;
  description: number;
  /** Optional: some exports carry the operation's own currency and amount separately. */
  currency?: number | null;
  comment?: number | null;
  /**
   * Optional, but the single highest-value column after the mandatory three: the deterministic
   * categoriser is driven mainly by MCC rules (188 of them), so an import without MCC lands as
   * a pile of uncategorised rows even though the bank told us what each purchase was.
   */
  mcc?: number | null;
}

const HINTS: Record<keyof ColumnMapping, string[]> = {
  // ⚠️ Order matters twice over: an EXACT match is tried against this whole list before any
  // partial one, so the most specific spelling has to be present, not merely matchable. Real
  // exports write phrases ("Amount in card currency"), and a bank that offers an English export
  // is the common case for anyone who ever switched their banking app to English.
  date: ["дата", "date", "час", "time", "дата i час", "дата і час", "дата та час", "дата операції",
    "date and time of transaction"],
  // "Amount in card currency" must win over "Amount in transaction currency": our invariant is
  // that `amount` is in the ACCOUNT's currency (§R2-CUR1). Partial matching happens to pick the
  // first of the two, which is the right one by luck — the exact hint makes it right by rule.
  amount: ["сума", "amount", "сума в валюті картки", "сума у валюті картки", "сума операції", "debit", "credit",
    "amount in card currency", "сума у валюті рахунку"],
  description: ["опис", "description", "деталі", "призначення", "контрагент", "merchant", "деталі операції",
    "details of the operation", "details", "purpose", "призначення платежу"],
  currency: ["валюта", "currency"],
  comment: ["коментар", "comment", "примітка", "note"],
  mcc: ["mcc", "мсс", "код мсс", "mcc-код"],
};

/**
 * Best-effort column guess from the header row.
 *
 * Deliberately a GUESS shown for confirmation, never an automatic decision: a wrong amount
 * column does not throw, it just imports a month of wrong numbers, and nobody re-reads a
 * statement they already imported.
 */
export function guessMapping(headers: string[]): Partial<ColumnMapping> {
  const normalised = headers.map((h) => h.trim().toLocaleLowerCase("uk"));
  const find = (key: keyof ColumnMapping): number | undefined => {
    const hints = HINTS[key];
    // Exact match first — "сума" must not lose to "сума комісії" just because it comes later.
    for (const hint of hints) {
      const exact = normalised.indexOf(hint);
      if (exact >= 0) return exact;
    }
    for (const hint of hints) {
      const partial = normalised.findIndex((h) => h.includes(hint));
      if (partial >= 0) return partial;
    }
    return undefined;
  };
  const out: Partial<ColumnMapping> = {};
  for (const key of Object.keys(HINTS) as (keyof ColumnMapping)[]) {
    const idx = find(key);
    if (idx !== undefined) out[key] = idx;
  }
  return out;
}

/**
 * Where the TABLE starts — because a bank statement does not start with its table.
 *
 * The Raiffeisen export that prompted this opens with 23 lines of preamble: the bank's own
 * details, the client's full identity, the account, the period and the totals. Treating row 0 as
 * the header meant handing the guesser `["Raiffeisen Bank JSC"]`, which maps to nothing — so the
 * app answered "I cannot read these columns" about a perfectly ordinary file, and the only way
 * forward was for the user to map columns by hand against the wrong row.
 *
 * Scored rather than pattern-matched: the header is the row that yields the most mappable
 * columns, which stays true for a bank whose preamble or wording nobody has seen yet. A file
 * whose real header is row 0 scores there and nothing changes for it.
 */
export function findHeaderRow(rows: string[][], maxScan = 40): { index: number; mapping: Partial<ColumnMapping> } {
  let best = { index: 0, mapping: guessMapping(rows[0] ?? []), score: -1 };
  const score = (m: Partial<ColumnMapping>) =>
    // The three mandatory columns are worth an order of magnitude more than the optional ones: a
    // row matching "currency" and "mcc" alone is not a header, it is a coincidence.
    (m.date != null ? 10 : 0) + (m.amount != null ? 10 : 0) + (m.description != null ? 10 : 0) +
    (m.currency != null ? 1 : 0) + (m.mcc != null ? 1 : 0) + (m.comment != null ? 1 : 0);

  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const mapping = guessMapping(rows[i]!);
    const s = score(mapping);
    // Strictly greater: on a tie the EARLIER row wins, so a data row that happens to contain the
    // word "date" cannot displace the real header above it.
    if (s > best.score) best = { index: i, mapping, score: s };
  }
  return { index: best.index, mapping: best.mapping };
}

// ---- conversion + import ----------------------------------------------------------------

/**
 * Stable id for an imported row.
 *
 * Dedup is by CONTENT, not by position: re-importing an overlapping export (the usual way
 * people use this — "last 3 months" every month) must not create a second copy of the same
 * purchase. The account is part of the hash so identical amounts on two cards stay distinct.
 */
async function rowId(accountId: string, time: number, amount: number, description: string): Promise<string> {
  const payload = `${accountId}|${time}|${amount}|${description}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `csv_${hex.slice(0, 32)}`;
}

export interface ConvertResult {
  txs: CanonicalTx[];
  /** Rows that could not be read, with the reason — surfaced in the preview, never swallowed. */
  skipped: { line: number; reason: string }[];
}

export async function toCanonical(
  rows: string[][],
  mapping: ColumnMapping,
  accountId: string,
  currencyCode: number,
  hasHeader = true,
  // Skip reasons are printed row-by-row in the import preview, so they follow the reader's
  // locale (B3). Defaulted rather than required: this stays callable from a test or a script
  // that has no user context.
  locale: ServerLocale = "uk",
): Promise<ConvertResult> {
  const txs: CanonicalTx[] = [];
  const skipped: { line: number; reason: string }[] = [];
  const body = hasHeader ? rows.slice(1) : rows;

  for (let i = 0; i < body.length; i++) {
    const row = body[i]!;
    const line = i + (hasHeader ? 2 : 1);
    const time = parseDateUnix(row[mapping.date] ?? "");
    if (time === null) {
      skipped.push({ line, reason: st(locale, "csvBadDate", { value: (row[mapping.date] ?? "").slice(0, 32) }) });
      continue;
    }
    const amount = parseAmountMinor(row[mapping.amount] ?? "");
    if (amount === null) {
      skipped.push({ line, reason: st(locale, "csvBadAmount", { value: (row[mapping.amount] ?? "").slice(0, 32) }) });
      continue;
    }
    if (amount === 0) {
      skipped.push({ line, reason: st(locale, "csvZeroAmount") });
      continue;
    }
    const description = (row[mapping.description] ?? "").trim();
    const comment = mapping.comment != null ? (row[mapping.comment] ?? "").trim() : "";
    // MCC is a plain 4-digit code; anything else in that cell is not one, and passing garbage
    // through would make the rule engine match on nonsense.
    const mccRaw = mapping.mcc != null ? (row[mapping.mcc] ?? "").trim() : "";
    const mcc = /^\d{3,4}$/.test(mccRaw) ? Number(mccRaw) : null;
    txs.push({
      id: await rowId(accountId, time, amount, description),
      account_id: accountId,
      time,
      amount,
      currency_code: currencyCode,
      mcc,
      description: description || null,
      comment: comment || null,
    });
  }
  return { txs, skipped };
}

export interface ImportResult {
  inserted: number;
  duplicates: number;
}

/**
 * Writes canonical rows through the one shared writer (`repo/ingest.ts`).
 *
 * Dedup is by the content hash and nothing else — no "have I imported this file before?"
 * bookkeeping, which would be wrong anyway the moment two exports overlap.
 *
 * `onConflict: "ignore"` is the half that belongs to a FILE rather than to a bank: a re-imported
 * row is a duplicate of something already stored — and possibly re-categorised or renamed by hand
 * since — so it is left alone. A feed means the opposite by the same id (BANKS.md §4.4).
 */
export async function importTransactions(db: AppDb, txs: CanonicalTx[]): Promise<ImportResult> {
  const { upsertCanonicalTx } = await import("../../../repo/ingest.ts");
  let inserted = 0;
  for (const tx of txs) {
    const res = await upsertCanonicalTx(db, tx, { source: "import", onConflict: "ignore" });
    if (res.inserted) inserted++;
  }
  return { inserted, duplicates: txs.length - inserted };
}

export const csvProvider: BankProvider = {
  id: "csv",
  label: "Імпорт із файлу (CSV)",
  mode: "manual",
};
