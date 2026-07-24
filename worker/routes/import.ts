// CSV statement import (PLATFORM.md §5, P1.2). Runs inside the user's Durable Object.
//
// Two endpoints on purpose. `preview` writes nothing and answers "here is what I understood",
// `commit` writes. A one-shot import would mean the user discovers a wrong amount column only
// after a month of wrong numbers is already in the canon — and nobody re-reads a statement they
// have already imported.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import {
  detectDelimiter,
  guessMapping,
  importTransactions,
  parseCsv,
  toCanonical,
  type ColumnMapping,
} from "../lib/banks/csv.ts";

export const importRoutes = new Hono<{ Bindings: Env }>();

const MAX_CHARS = 4_000_000; // ~4 MB of text; a decade of statements fits comfortably

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
  const headers = rows[0]!;
  const guessed = { ...guessMapping(headers), ...(body.mapping ?? {}) };

  // Without a full mapping there is nothing to convert yet — return the headers so the UI can
  // ask, instead of inventing columns.
  if (guessed.date == null || guessed.amount == null || guessed.description == null) {
    return c.json({
      delimiter,
      headers,
      sample: rows.slice(1, 6),
      total_rows: rows.length - (hasHeader ? 1 : 0),
      mapping: guessed,
      complete: false,
    });
  }

  const account = body.account_id
    ? await c.env.DB.prepare("SELECT id, currency_code FROM accounts WHERE id = ?")
        .bind(body.account_id)
        .first<{ id: string; currency_code: number | null }>()
    : null;

  const { txs, skipped } = await toCanonical(
    rows,
    guessed as ColumnMapping,
    account?.id ?? "preview",
    account?.currency_code ?? 980,
    hasHeader,
  );

  // Which of these rows are already in the database. Shown BEFORE writing, because "imported
  // 0 of 300" after the fact reads as a failure when it is actually a correct no-op.
  let duplicates = 0;
  if (account && txs.length) {
    const ids = txs.map((t) => t.id);
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const row = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE id IN (${chunk.map(() => "?").join(",")})`,
      )
        .bind(...chunk)
        .first<number>("n");
      duplicates += Number(row ?? 0);
    }
  }

  return c.json({
    delimiter,
    headers,
    sample: rows.slice(1, 6),
    total_rows: rows.length - (hasHeader ? 1 : 0),
    mapping: guessed,
    complete: true,
    parsed: txs.length,
    duplicates,
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

  const account = await c.env.DB.prepare("SELECT id, currency_code FROM accounts WHERE id = ?")
    .bind(body.account_id)
    .first<{ id: string; currency_code: number | null }>();
  if (!account) return c.json({ error: "unknown_account" }, 400);

  const delimiter = body.delimiter || detectDelimiter(body.text);
  const rows = parseCsv(body.text, delimiter);
  const hasHeader = body.has_header ?? true;
  const mapping = { ...guessMapping(rows[0] ?? []), ...(body.mapping ?? {}) };
  if (mapping.date == null || mapping.amount == null || mapping.description == null) {
    return c.json({ error: "incomplete_mapping" }, 400);
  }

  const { txs, skipped } = await toCanonical(
    rows,
    mapping as ColumnMapping,
    account.id,
    account.currency_code ?? 980,
    hasHeader,
  );
  const result = await importTransactions(c.env.DB, txs);

  // Imported rows can complete a transfer pair with rows that came from the bank webhook.
  // Best-effort: a failure here must not undo a successful import.
  try {
    const { detectTransfers } = await import("../lib/transfers.ts");
    await detectTransfers(c.env);
  } catch {
    /* transfer detection is best-effort */
  }

  return c.json({ ok: true, ...result, skipped: skipped.length });
});
