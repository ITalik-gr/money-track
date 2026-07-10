// Setup & sync: pull mono accounts, register the webhook, and run the paced ~90-day
// backfill (§5). Statement is limited to 1 req / 60s, so backfill is a cursor of
// (account, window) pairs stepped one request at a time; the client drives the 60s
// spacing and shows progress. Cursor lives in app_state so it survives interruption.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { getClientInfo, MonoRateLimit } from "../lib/mono.ts";
import { getState, setState, syncAccounts } from "../lib/repo.ts";
import { type Cursor, CURSOR_KEY, startBackfill, stepBackfill } from "../lib/backfill.ts";

export const setup = new Hono<{ Bindings: Env }>();

setup.post("/sync-accounts", async (c) => {
  if (!c.env.MONO_TOKEN) return c.json({ error: "MONO_TOKEN not set" }, 400);
  try {
    const info = await getClientInfo(c.env.MONO_TOKEN);
    await syncAccounts(c.env.DB, info);
    return c.json({ ok: true, accounts: info.accounts.length, jars: info.jars?.length ?? 0 });
  } catch (e) {
    if (e instanceof MonoRateLimit) return c.json({ error: "rate_limited", retryAfter: 60 }, 429);
    return c.json({ error: String(e) }, 502);
  }
});

setup.post("/register-webhook", async (c) => {
  if (!c.env.MONO_TOKEN) return c.json({ error: "MONO_TOKEN not set" }, 400);
  const { setWebhook } = await import("../lib/mono.ts");
  const origin = new URL(c.req.url).origin;
  const url = `${origin}/webhook/${c.env.WEBHOOK_SECRET}`;
  try {
    await setWebhook(c.env.MONO_TOKEN, url);
    await setState(c.env.DB, "webhook_url", url);
    return c.json({ ok: true, url });
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// Register the Telegram webhook once: points TG at /tg/<TG_SECRET> and sets the
// secret_token so incoming updates carry X-Telegram-Bot-Api-Secret-Token = TG_SECRET.
setup.post("/register-telegram", async (c) => {
  if (!c.env.TG_BOT_TOKEN || !c.env.TG_SECRET) return c.json({ error: "TG_BOT_TOKEN / TG_SECRET not set" }, 400);
  const { setWebhook } = await import("../lib/telegram.ts");
  const origin = new URL(c.req.url).origin;
  const url = `${origin}/tg/${c.env.TG_SECRET}`;
  try {
    await setWebhook(c.env.TG_BOT_TOKEN, url, c.env.TG_SECRET);
    await setState(c.env.DB, "tg_webhook_url", url);
    return c.json({ ok: true, url });
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// Build the cursor over all mono accounts × monthly windows for ~90 days.
// The minute-cron also advances it, so it finishes even if the tab is closed.
setup.post("/backfill/start", async (c) => {
  const cursor = await startBackfill(c.env);
  return c.json({ ok: true, total: cursor.total, estimateMinutes: cursor.total });
});

// Perform exactly one statement request and advance. Client calls every 60s.
setup.post("/backfill/step", async (c) => {
  try {
    const r = await stepBackfill(c.env);
    if (!r) return c.json({ error: "no_backfill_in_progress" }, 400);
    return c.json(r);
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

setup.get("/status", async (c) => {
  const webhook = await getState(c.env.DB, "webhook_url");
  const raw = await getState(c.env.DB, CURSOR_KEY);
  const accounts = await c.env.DB.prepare("SELECT COUNT(*) n FROM accounts").first<{ n: number }>();
  const txCount = await c.env.DB.prepare("SELECT COUNT(*) n FROM transactions").first<{ n: number }>();
  const cursor: Cursor | null = raw ? JSON.parse(raw) : null;
  return c.json({
    webhookRegistered: !!webhook,
    accounts: accounts?.n ?? 0,
    transactions: txCount?.n ?? 0,
    backfill: cursor ? { progress: cursor.idx, total: cursor.total, done: cursor.idx >= cursor.total } : null,
  });
});
