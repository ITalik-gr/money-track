// AI ingest (§6.1/§6.2). Receipt: store original in R2, read via Haiku, try to attach
// to an existing mono tx by amount+date, else create a source='cash' tx. Text: parse
// to a structured record and return it for the client to confirm/save.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { parseText } from "../lib/ai/enrich.ts";
import { ingestReceipt } from "../lib/ai/receipt.ts";
import { st } from "../lib/platform/i18n.ts";
import { ownerLocale } from "../lib/finance/categories-i18n.ts";
import { countReceiptUpload, DAILY_RECEIPTS } from "../lib/platform/quota.ts";

export const ingest = new Hono<{ Bindings: Env }>();

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 4000; // a hand-typed expense note; anything longer is a paste-bomb

async function requireKey(env: Env): Promise<string | null> {
  return env.ANTHROPIC_API_KEY ? null : st(await ownerLocale(env.DB), "errAiKeyMissing");
}

ingest.post("/receipt", async (c) => {
  const err = await requireKey(c.env);
  if (err) return c.json({ error: err }, 400);

  const form = await c.req.formData();
  const file = form.get("image");
  if (!(file instanceof File)) return c.json({ error: "image file required" }, 400);
  // Anthropic rejects images over 5 MB anyway, so anything larger is money spent on an R2 write
  // for a request that cannot succeed. Refusing before the upload keeps the bucket clean too.
  if (file.size > MAX_IMAGE_BYTES) {
    return c.json({ error: `image too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)` }, 413);
  }

  // Daily ceiling, counted AFTER the size check so refused files cost nobody their allowance.
  // This is the only route that writes a user's FILE into shared storage, and since registration
  // opened, "signed in" no longer means "someone the owner knows" (security pass, 2026-08-07).
  const quota = await countReceiptUpload(c.env);
  if (!quota.ok) {
    return c.json(
      { error: st(await ownerLocale(c.env.DB), "errReceiptQuota", { n: String(DAILY_RECEIPTS) }) },
      429,
      { "retry-after": "3600" },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const out = await ingestReceipt(c.env, bytes, file.type || "image/jpeg");
  return c.json({ ok: true, ...out });
});

ingest.post("/text", async (c) => {
  const err = await requireKey(c.env);
  if (err) return c.json({ error: err }, 400);
  const { text } = await c.req.json<{ text: string }>();
  if (!text?.trim()) return c.json({ error: "text required" }, 400);
  const { result, usage } = await parseText(c.env, text.slice(0, MAX_TEXT_CHARS));
  // Return parsed record for the client to confirm before saving.
  return c.json({ ok: true, result, usage });
});
