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

/**
 * "-1 234,56" / "1234.56" / "(1 234,56)" → minor units (integer kopecks).
 *
 * Money stays INTEGER everywhere in this project, so the conversion rounds ONCE, here. Parsing
 * to a float and multiplying later is how 1234.56 becomes 123455 kopecks.
 */
export function parseAmountMinor(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  // Accounting notation for negatives.
  const parenthesised = /^\((.*)\)$/.exec(s);
  if (parenthesised) s = `-${parenthesised[1]}`;
  // Strip currency letters, ordinary spaces, non-breaking spaces and thin spaces used as
  // thousand separators by Ukrainian exports.
  s = s.replace(/[\s   ]/g, "").replace(/[^\d.,+-]/g, "");
  if (!s) return null;
  // Decide which of `.` and `,` is the decimal separator: the LAST one that appears, since the
  // other is then a thousands separator ("1.234,56" and "1,234.56" both resolve correctly).
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const decimalPos = Math.max(lastComma, lastDot);
  let intPart = s;
  let fracPart = "";
  if (decimalPos >= 0) {
    intPart = s.slice(0, decimalPos);
    fracPart = s.slice(decimalPos + 1);
    // More than two digits after the separator means it was a thousands separator after all
    // ("1.234" is one thousand two hundred, not 1.23).
    if (!/^\d{1,2}$/.test(fracPart)) {
      intPart = s;
      fracPart = "";
    }
  }
  intPart = intPart.replace(/[.,]/g, "");
  const negative = intPart.startsWith("-");
  const digits = intPart.replace(/[^\d]/g, "");
  if (!digits && !fracPart) return null;
  const minor = Number(digits || "0") * 100 + Number((fracPart + "00").slice(0, 2));
  return negative ? -minor : minor;
}

/** Statement date → unix seconds. Returns `null` rather than guessing when the shape is unknown. */
export function parseDateUnix(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;

  // dd.mm.yyyy [hh:mm[:ss]] — monobank and PrivatBank exports.
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (dotted) {
    const [, d, m, y, hh = "0", mm = "0", ss = "0"] = dotted;
    return Math.floor(Date.UTC(+y!, +m! - 1, +d!, +hh, +mm, +ss) / 1000);
  }
  // yyyy-mm-dd [hh:mm[:ss]]
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (iso) {
    const [, y, m, d, hh = "0", mm = "0", ss = "0"] = iso;
    return Math.floor(Date.UTC(+y!, +m! - 1, +d!, +hh, +mm, +ss) / 1000);
  }
  // Unix seconds, already.
  if (/^\d{9,10}$/.test(s)) return Number(s);
  return null;
}

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
  date: ["дата", "date", "час", "time", "дата i час", "дата і час", "дата та час", "дата операції"],
  amount: ["сума", "amount", "сума в валюті картки", "сума у валюті картки", "сума операції", "debit", "credit"],
  description: ["опис", "description", "деталі", "призначення", "контрагент", "merchant", "деталі операції"],
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
 * Writes canonical rows, running each through the deterministic categoriser.
 *
 * `INSERT OR IGNORE` on the content hash is the whole dedup story — no "have I imported this
 * file before?" bookkeeping, which would be wrong anyway the moment two exports overlap.
 */
export async function importTransactions(db: AppDb, txs: CanonicalTx[]): Promise<ImportResult> {
  const { categorize } = await import("../../finance/categorize.ts");
  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;

  for (const tx of txs) {
    const { category_id, display_name, is_transfer, real_category_id, planned_id } = await categorize(db, {
      mcc: tx.mcc ?? null,
      description: tx.description ?? null,
      amount: tx.amount,
      currency_code: tx.currency_code,
    });
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO transactions
           (id, account_id, source, time, amount, currency_code, mcc, category_id, real_category_id,
            planned_id, merchant, comment, hold, is_transfer, created_at)
         VALUES (?, ?, 'import', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(
        tx.id,
        tx.account_id,
        tx.time,
        tx.amount,
        tx.currency_code,
        tx.mcc ?? null,
        category_id,
        real_category_id,
        planned_id,
        display_name ?? tx.description ?? null,
        tx.comment ?? null,
        is_transfer ? 1 : 0,
        now,
      )
      .run();
    if (res.meta.changes > 0) inserted++;
  }
  return { inserted, duplicates: txs.length - inserted };
}

export const csvProvider: BankProvider = {
  id: "csv",
  label: "Імпорт із файлу (CSV)",
  mode: "manual",
};
