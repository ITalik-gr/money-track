// "Keys & connections": the user's own monobank token and Anthropic key (PLATFORM.md §4).
//
// Runs INSIDE the user's Durable Object, so `c.env.DB` is already their private database and
// there is no user id to check against — the routing did that.
//
// Non-negotiable rule in here: a stored value is NEVER sent back to a client. Not masked,
// not partially, not "for editing". The UI works from status alone, which is why the status
// carries `last_ok_at`: without it, a token that silently expired looks exactly like a token
// that works, and the user would go hunting through the app for the wrong bug.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { getClientInfo, MonoRateLimit } from "../lib/bank/mono.ts";
import { deleteSecret, putSecret, secretStatuses, SECRET_NAMES, type SecretName } from "../lib/platform/secrets.ts";

export const credentials = new Hono<{ Bindings: Env }>();

function isSecretName(v: string): v is SecretName {
  return (SECRET_NAMES as string[]).includes(v);
}

/** Cheapest call that proves an Anthropic key works: count tokens, no generation, no cost. */
async function verifyAnthropic(key: string): Promise<boolean> {
  const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  return res.ok;
}

credentials.get("/", async (c) => c.json({ secrets: await secretStatuses(c.env.DB) }));

credentials.put("/:name", async (c) => {
  const name = c.req.param("name");
  if (!isSecretName(name)) return c.json({ error: "unknown_secret" }, 400);
  const { value } = await c.req.json<{ value?: string }>().catch(() => ({ value: undefined }));
  if (!value || !value.trim()) return c.json({ error: "empty_value" }, 400);
  const secret = value.trim();

  // Verify BEFORE storing. A credential that is wrong from the start is indistinguishable in
  // the UI from one that is right, and the failure would only surface later as "the backfill
  // does nothing" or "the advisor is broken" — far from the screen where it was typed.
  let ok = false;
  let detail: string | null = null;
  try {
    if (name === "mono_token") {
      await getClientInfo(secret);
      ok = true;
    } else {
      ok = await verifyAnthropic(secret);
      if (!ok) detail = "Anthropic відхилив ключ";
    }
  } catch (e) {
    if (e instanceof MonoRateLimit) {
      // Mono allows one client-info call per 60s. Rejecting the token here would be a lie —
      // we simply could not check it, so store it and let the status stay "not verified".
      detail = "monobank обмежив перевірку (1 запит/60с) — токен збережено без звірки";
    } else {
      detail = e instanceof Error ? e.message : String(e);
    }
  }

  if (!ok && detail === null) return c.json({ error: "verification_failed" }, 400);
  if (!ok && name === "anthropic_api_key") return c.json({ error: detail ?? "verification_failed" }, 400);

  await putSecret(c.env.DB, c.env.SECRETS_MASTER_KEY, name, secret, ok);
  // The Durable Object caches decrypted credentials for its lifetime; without this the next
  // request would still call monobank with the OLD token and the user would conclude that
  // saving a new one does nothing.
  c.env.onSecretsChanged?.();
  return c.json({ ok: true, verified: ok, detail, secrets: await secretStatuses(c.env.DB) });
});

credentials.delete("/:name", async (c) => {
  const name = c.req.param("name");
  if (!isSecretName(name)) return c.json({ error: "unknown_secret" }, 400);
  await deleteSecret(c.env.DB, name);
  c.env.onSecretsChanged?.();
  return c.json({ ok: true, secrets: await secretStatuses(c.env.DB) });
});
