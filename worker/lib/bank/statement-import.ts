/**
 * One statement, from raw text to a preview or a commit. The pipeline itself, with no transport.
 *
 * WHY IT LEFT `routes/import.ts` (2026-09-02, §TG-CSV). The bot can now be handed a statement in
 * a chat, and that is a second caller for work that had lived inside two HTTP handlers. Copying it
 * would have broken the rule those handlers already state out loud: preview and commit MUST
 * resolve the mapping the same way, or a file mapped by AI in the preview and by hints at commit
 * imports different columns than the person approved. A third caller with its own copy makes that
 * failure silent AND cross-surface — approve in Telegram, import something else.
 *
 * So the route layer keeps what it is for (parse the request, choose a status code) and everything
 * that decides WHAT GETS IMPORTED lives here, once.
 */
import type { Env } from "../../env.ts";
import { resolveLocale } from "../platform/i18n.ts";
import {
  detectDelimiter, findHeaderRow, guessMapping, importTransactions, parseCsv, toCanonical,
  type ColumnMapping,
} from "./providers/csv.ts";
import { currencyNumeric } from "./normalize.ts";
import { findForImport } from "../../repo/accounts.ts";
import { countExisting } from "../../repo/transactions.ts";

/** ~4 MB of text; a decade of statements fits comfortably. */
export const MAX_CHARS = 4_000_000;

/**
 * The currency the FILE names, when it is not the currency the ACCOUNT holds.
 *
 * The account stays the authority — that decision is pinned by a golden and is not reopened here.
 * But an account is only the authority over what a number MEANS, not over whether the user picked
 * the right one: importing a USD statement into a hryvnia account stores every amount as hryvnia,
 * which is wrong by roughly a factor of forty and looks completely ordinary on screen. Nothing
 * downstream can catch it, because there is no trace left that the file ever said otherwise.
 *
 * So the preview says it, in the one place where the import can still be stopped. Returns the raw
 * text from the file rather than a code: it is what the user will recognise in their own export.
 */
export function fileCurrencyMismatch(
  rows: string[][], mapping: ColumnMapping, accountCurrency: number | null, hasHeader: boolean,
): string | null {
  if (mapping.currency == null || accountCurrency == null) return null;
  for (const row of hasHeader ? rows.slice(1) : rows) {
    const raw = (row[mapping.currency] ?? "").trim();
    if (!raw) continue;
    const code = currencyNumeric(raw);
    // An unrecognised code is NOT reported as a mismatch: we would be claiming the file disagrees
    // when in truth we could not read it, and a warning that cries wolf gets clicked through.
    if (code != null && code !== accountCurrency) return raw;
  }
  return null;
}

/**
 * §CSV-AI — the column mapping, from the cheapest source that works.
 *
 * Order: what the USER said, then the hint table, then — only if the three mandatory columns are
 * still missing — one model call for the whole FILE (`lib/ai/statement-map.ts`).
 */
export async function resolveMapping(
  env: Env, table: string[][], fromHints: Partial<ColumnMapping>, fromUser: Partial<ColumnMapping> | undefined,
): Promise<{ mapping: Partial<ColumnMapping>; source: "hints" | "user" | "ai" }> {
  const merged = { ...fromHints, ...(fromUser ?? {}) };
  const complete = (m: Partial<ColumnMapping>) =>
    m.date != null && m.amount != null && m.description != null;
  if (complete(merged)) return { mapping: merged, source: fromUser && Object.keys(fromUser).length ? "user" : "hints" };

  const { mapStatementColumns } = await import("../ai/statement-map.ts");
  const guessed = await mapStatementColumns(env, table);
  if (!guessed) return { mapping: merged, source: "hints" };
  // The user's own choices still win over the model's: they are looking at the file.
  const ai: Partial<ColumnMapping> = {
    date: guessed.mapping.date ?? undefined, amount: guessed.mapping.amount ?? undefined,
    description: guessed.mapping.description ?? undefined,
    currency: guessed.mapping.currency, comment: guessed.mapping.comment, mcc: guessed.mapping.mcc,
  };
  const out = { ...merged, ...Object.fromEntries(Object.entries(ai).filter(([, v]) => v != null)), ...(fromUser ?? {}) };
  return { mapping: out, source: complete(out) ? "ai" : "hints" };
}

export interface StatementOpts {
  delimiter?: string;
  hasHeader?: boolean;
  mapping?: Partial<ColumnMapping>;
  accountId?: string;
}

/**
 * The table under the preamble, plus the mapping — the part preview and commit MUST agree on.
 *
 * A statement does not start with its table (see `findHeaderRow`); everything above the header is
 * preamble and is REPORTED rather than silently dropped, because a row that disappears without a
 * reason is the one thing this import path refuses to do.
 */
async function readTable(env: Env, text: string, o: StatementOpts) {
  const delimiter = o.delimiter || detectDelimiter(text);
  const rows = parseCsv(text, delimiter);
  const hasHeader = o.hasHeader ?? true;
  const found = hasHeader ? findHeaderRow(rows) : { index: 0, mapping: guessMapping(rows[0] ?? []) };
  const table = rows.slice(found.index);
  const { mapping, source } = await resolveMapping(env, table, found.mapping, o.mapping);
  return { delimiter, rows, table, hasHeader, preamble: found.index, mapping, source };
}

export const mappingComplete = (m: Partial<ColumnMapping>): m is ColumnMapping =>
  m.date != null && m.amount != null && m.description != null;

export interface StatementPreview {
  delimiter: string;
  headers: string[];
  sample: string[][];
  total_rows: number;
  mapping: Partial<ColumnMapping>;
  complete: boolean;
  preamble_rows: number;
  /** Said out loud so a screen can label it: a mapping the model proposed is still a GUESS, and a
   *  guess that does not admit to being one is the kind that gets approved without a look. */
  mapping_source: "hints" | "user" | "ai";
  parsed?: number;
  duplicates?: number;
  currency_mismatch?: string | null;
  skipped?: { line: number; reason: string }[];
  skipped_total?: number;
  preview?: { time: number; amount: number; description: string | null | undefined }[];
  /** The window the file covers, so a caller can say WHICH statement this is. */
  first_time?: number;
  last_time?: number;
}

/** Writes nothing. Answers «here is what I understood», so a wrong amount column is caught before
 *  a month of wrong numbers is in the canon — nobody re-reads a statement already imported. */
export async function previewStatement(env: Env, text: string, o: StatementOpts = {}): Promise<StatementPreview | { error: string }> {
  if (!text) return { error: "empty_file" };
  if (text.length > MAX_CHARS) return { error: "file_too_large" };
  const r = await readTable(env, text, o);
  if (!r.rows.length) return { error: "no_rows" };

  const base: StatementPreview = {
    delimiter: r.delimiter,
    headers: r.table[0] ?? [],
    sample: r.table.slice(1, 6),
    total_rows: r.table.length - (r.hasHeader ? 1 : 0),
    mapping: r.mapping,
    complete: mappingComplete(r.mapping),
    preamble_rows: r.preamble,
    mapping_source: r.source,
  };
  // Without a full mapping there is nothing to convert yet — return the headers so the caller can
  // ask, instead of inventing columns.
  if (!mappingComplete(r.mapping)) return base;

  const account = o.accountId ? await findForImport(env.DB, o.accountId) : null;
  const { txs, skipped } = await toCanonical(
    r.table, r.mapping, account?.id ?? "preview", account?.currency_code ?? 980, r.hasHeader,
    await resolveLocale(env),
  );
  // Which of these rows are already in the database. Shown BEFORE writing, because "imported
  // 0 of 300" after the fact reads as a failure when it is actually a correct no-op.
  const duplicates = account && txs.length ? await countExisting(env.DB, txs.map((t) => t.id)) : 0;
  const times = txs.map((t) => t.time);

  return {
    ...base,
    parsed: txs.length,
    duplicates,
    currency_mismatch: fileCurrencyMismatch(r.table, r.mapping, account?.currency_code ?? null, r.hasHeader),
    skipped: skipped.slice(0, 20),
    skipped_total: skipped.length,
    preview: txs.slice(0, 8).map((t) => ({ time: t.time, amount: t.amount, description: t.description })),
    first_time: times.length ? Math.min(...times) : undefined,
    last_time: times.length ? Math.max(...times) : undefined,
  };
}

export interface StatementCommit { ok: true; inserted: number; duplicates: number; skipped: number }

/** Writes. Everything it decides was already decided identically by `previewStatement`. */
export async function commitStatement(
  env: Env, text: string, accountId: string, o: StatementOpts = {},
): Promise<StatementCommit | { error: string }> {
  if (!text) return { error: "empty_file" };
  if (text.length > MAX_CHARS) return { error: "file_too_large" };

  const account = await findForImport(env.DB, accountId);
  if (!account) return { error: "unknown_account" };

  const r = await readTable(env, text, o);
  if (!mappingComplete(r.mapping)) return { error: "incomplete_mapping" };

  const { txs, skipped } = await toCanonical(
    r.table, r.mapping, account.id, account.currency_code ?? 980, r.hasHeader, await resolveLocale(env),
  );
  const result = await importTransactions(env.DB, txs);

  // Imported rows can complete a transfer pair with rows that came from the bank webhook.
  // Best-effort: a failure here must not undo a successful import.
  try {
    const { detectTransfers } = await import("../finance/transfers.ts");
    await detectTransfers(env);
  } catch {
    /* transfer detection is best-effort */
  }
  return { ok: true, ...result, skipped: skipped.length };
}
