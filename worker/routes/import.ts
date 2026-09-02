// CSV statement import (PLATFORM.md §5, P1.2). Runs inside the user's Durable Object.
//
// Two endpoints on purpose. `preview` writes nothing and answers "here is what I understood",
// `commit` writes. A one-shot import would mean the user discovers a wrong amount column only
// after a month of wrong numbers is already in the canon — and nobody re-reads a statement they
// have already imported.
//
// ⚠️ TRANSPORT ONLY since 2026-09-02 (§TG-CSV). Everything that decides WHAT GETS IMPORTED moved
// to `lib/bank/statement-import.ts` when the Telegram bot became a second caller: preview and
// commit must resolve the mapping identically, and a third copy of that resolution would make the
// disagreement silent AND cross-surface — approve in the chat, import something else.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import type { ColumnMapping } from "../lib/bank/providers/csv.ts";
import { commitStatement, previewStatement } from "../lib/bank/statement-import.ts";

export const importRoutes = new Hono<{ Bindings: Env }>();

interface PreviewBody {
  text?: string;
  delimiter?: string;
  account_id?: string;
  mapping?: Partial<ColumnMapping>;
  has_header?: boolean;
}

/** The pipeline's refusals, each with the status code the transport layer owes it. */
const STATUS: Record<string, 400> = {
  empty_file: 400, file_too_large: 400, no_rows: 400,
  account_required: 400, unknown_account: 400, incomplete_mapping: 400,
};

const opts = (b: PreviewBody) => ({
  delimiter: b.delimiter, hasHeader: b.has_header, mapping: b.mapping, accountId: b.account_id,
});

importRoutes.post("/csv/preview", async (c) => {
  const body = await c.req.json<PreviewBody>().catch(() => ({}) as PreviewBody);
  const r = await previewStatement(c.env, body.text ?? "", opts(body));
  if ("error" in r) return c.json({ error: r.error }, STATUS[r.error] ?? 400);
  return c.json(r);
});

importRoutes.post("/csv/commit", async (c) => {
  const body = await c.req.json<PreviewBody>().catch(() => ({}) as PreviewBody);
  if (!body.account_id) return c.json({ error: "account_required" }, 400);
  const r = await commitStatement(c.env, body.text ?? "", body.account_id, opts(body));
  if ("error" in r) return c.json({ error: r.error }, STATUS[r.error] ?? 400);
  return c.json(r);
});
