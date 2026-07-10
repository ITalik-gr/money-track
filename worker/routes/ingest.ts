// AI ingest (§6.1/§6.2). Receipt: store original in R2, read via Haiku, try to attach
// to an existing mono tx by amount+date, else create a source='cash' tx. Text: parse
// to a structured record and return it for the client to confirm/save.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { parseText } from "../lib/ai.ts";
import { ingestReceipt } from "../lib/receipt.ts";

export const ingest = new Hono<{ Bindings: Env }>();

function requireKey(env: Env): string | null {
  return env.ANTHROPIC_API_KEY ? null : "ANTHROPIC_API_KEY not set — див. інструкцію в README";
}

ingest.post("/receipt", async (c) => {
  const err = requireKey(c.env);
  if (err) return c.json({ error: err }, 400);

  const form = await c.req.formData();
  const file = form.get("image");
  if (!(file instanceof File)) return c.json({ error: "image file required" }, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const out = await ingestReceipt(c.env, bytes, file.type || "image/jpeg");
  return c.json({ ok: true, ...out });
});

ingest.post("/text", async (c) => {
  const err = requireKey(c.env);
  if (err) return c.json({ error: err }, 400);
  const { text } = await c.req.json<{ text: string }>();
  if (!text?.trim()) return c.json({ error: "text required" }, 400);
  const { result, usage } = await parseText(c.env, text);
  // Return parsed record for the client to confirm before saving.
  return c.json({ ok: true, result, usage });
});
