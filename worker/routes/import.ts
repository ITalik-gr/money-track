// CSV statement import (PLATFORM.md §5, P1.2). Runs inside the user's Durable Object.
//
// Two endpoints on purpose. `preview` writes nothing and answers "here is what I understood",
// `commit` writes. A one-shot import would mean the user discovers a wrong amount column only
// after a month of wrong numbers is already in the canon — and nobody re-reads a statement they
// have already imported.
import { Hono } from "hono";
import { resolveLocale } from "../lib/platform/i18n.ts";
import type { Env } from "../env.ts";
import {
  detectDelimiter,
  findHeaderRow,
  guessMapping,
  importTransactions,
  parseCsv,
  toCanonical,
  type ColumnMapping,
} from "../lib/bank/providers/csv.ts";
import { currencyNumeric } from "../lib/bank/normalize.ts";
import { findForImport } from "../repo/accounts.ts";
import { countExisting } from "../repo/transactions.ts";

export const importRoutes = new Hono<{ Bindings: Env }>();

const MAX_CHARS = 4_000_000; // ~4 MB of text; a decade of statements fits comfortably

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
function fileCurrencyMismatch(
  rows: string[][],
  mapping: ColumnMapping,
  accountCurrency: number | null,
  hasHeader: boolean,
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

interface PreviewBody {
  text?: string;
  delimiter?: string;
  account_id?: string;
  mapping?: Partial<ColumnMapping>;
  has_header?: boolean;
}

importRoutes.post("/csv/preview", async (c) => {
  const body = await c.req.json<PreviewBody>().catch(() => ({}) as PreviewBody);
  if (!body.text) return c.json({ error: "empty_file" }, 400);
  if (body.text.length > MAX_CHARS) return c.json({ error: "file_too_large" }, 400);

  const delimiter = body.delimiter || detectDelimiter(body.text);
  const rows = parseCsv(body.text, delimiter);
  if (!rows.length) return c.json({ error: "no_rows" }, 400);

  const hasHeader = body.has_header ?? true;
  // A statement does not start with its table (see `findHeaderRow`). Everything above the header
  // is preamble and is REPORTED rather than silently dropped — a row that disappears without a
  // reason is the one thing this import path refuses to do.
  const found = hasHeader ? findHeaderRow(rows) : { index: 0, mapping: guessMapping(rows[0] ?? []) };
  const table = rows.slice(found.index);
  const headers = table[0]!;
  const guessed = { ...found.mapping, ...(body.mapping ?? {}) };

  // Without a full mapping there is nothing to convert yet — return the headers so the UI can
  // ask, instead of inventing columns.
  if (guessed.date == null || guessed.amount == null || guessed.description == null) {
    return c.json({
      delimiter,
      headers,
      sample: table.slice(1, 6),
      total_rows: table.length - (hasHeader ? 1 : 0),
      mapping: guessed,
      complete: false,
      preamble_rows: found.index,
    });
  }

  const account = body.account_id ? await findForImport(c.env.DB, body.account_id) : null;

  const { txs, skipped } = await toCanonical(
    table,
    guessed as ColumnMapping,
    account?.id ?? "preview",
    account?.currency_code ?? 980,
    hasHeader,
    await resolveLocale(c.env),
  );

  // Which of these rows are already in the database. Shown BEFORE writing, because "imported
  // 0 of 300" after the fact reads as a failure when it is actually a correct no-op.
  const duplicates = account && txs.length
    ? await countExisting(c.env.DB, txs.map((t) => t.id))
    : 0;

  return c.json({
    delimiter,
    headers,
    sample: table.slice(1, 6),
    total_rows: table.length - (hasHeader ? 1 : 0),
    mapping: guessed,
    complete: true,
    preamble_rows: found.index,
    parsed: txs.length,
    duplicates,
    currency_mismatch: fileCurrencyMismatch(table, guessed as ColumnMapping, account?.currency_code ?? null, hasHeader),
    skipped: skipped.slice(0, 20),
    skipped_total: skipped.length,
    preview: txs.slice(0, 8).map((t) => ({ time: t.time, amount: t.amount, description: t.description })),
  });
});

importRoutes.post("/csv/commit", async (c) => {
  const body = await c.req.json<PreviewBody>().catch(() => ({}) as PreviewBody);
  if (!body.text) return c.json({ error: "empty_file" }, 400);
  if (body.text.length > MAX_CHARS) return c.json({ error: "file_too_large" }, 400);
  if (!body.account_id) return c.json({ error: "account_required" }, 400);

  const account = await findForImport(c.env.DB, body.account_id);
  if (!account) return c.json({ error: "unknown_account" }, 400);

  const delimiter = body.delimiter || detectDelimiter(body.text);
  const rows = parseCsv(body.text, delimiter);
  const hasHeader = body.has_header ?? true;
  const found = hasHeader ? findHeaderRow(rows) : { index: 0, mapping: guessMapping(rows[0] ?? []) };
  const table = rows.slice(found.index);
  const mapping = { ...found.mapping, ...(body.mapping ?? {}) };
  if (mapping.date == null || mapping.amount == null || mapping.description == null) {
    return c.json({ error: "incomplete_mapping" }, 400);
  }

  const { txs, skipped } = await toCanonical(
    table,
    mapping as ColumnMapping,
    account.id,
    account.currency_code ?? 980,
    hasHeader,
    await resolveLocale(c.env),
  );
  const result = await importTransactions(c.env.DB, txs);

  // Imported rows can complete a transfer pair with rows that came from the bank webhook.
  // Best-effort: a failure here must not undo a successful import.
  try {
    const { detectTransfers } = await import("../lib/finance/transfers.ts");
    await detectTransfers(c.env);
  } catch {
    /* transfer detection is best-effort */
  }

  return c.json({ ok: true, ...result, skipped: skipped.length });
});
