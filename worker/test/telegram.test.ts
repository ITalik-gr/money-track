/**
 * The Telegram webhook. The observable behaviour is the OUTGOING calls (the reply is 200 for almost
 * everything), so `fetch` is replaced and every call to api.telegram.org is recorded.
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { telegram } from "../routes/telegram.ts";
import { migratedDb, testEnv, type MemDb } from "./harness.ts";
import { seed } from "./fixture.ts";

const SECRET = "test-secret";
const CHAT = "424242";

interface SentCall { method: string; body: Record<string, unknown> }

let sent: SentCall[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("api.telegram.org")) throw new Error(`unexpected fetch to ${url}`);
    // `/bot<token>/<method>` — the method name is the last segment.
    const method = url.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    sent.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: {} }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

function env(db: MemDb, linked = true) {
  if (linked) db.raw.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('tg_chat_id', ?)").run(CHAT);
  return { ...testEnv(db), TG_SECRET: SECRET, TG_BOT_TOKEN: "bot-token" };
}

/**
 * One update through the webhook, with both halves of the door satisfied unless told otherwise.
 *
 * The handler answers 200 immediately and does the work in `waitUntil` — Telegram retries anything
 * slow, so the bot must not hold the connection while it calls a model. That means the assertions
 * have to wait for those promises, which is why an ExecutionContext is supplied and drained here
 * rather than sleeping and hoping.
 */
async function send(e: Record<string, unknown>, update: unknown, opts?: { header?: string; path?: string }) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  const res = await telegram.request(opts?.path ?? `/${SECRET}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": opts?.header ?? SECRET,
    },
    body: JSON.stringify(update),
  }, e, ctx);
  await Promise.all(pending);
  return res;
}

const textMessage = (text: string) => ({
  message: { message_id: 1, text, chat: { id: Number(CHAT) }, from: { id: Number(CHAT) } },
});

test("tg: an update for another chat is acknowledged and otherwise ignored", async () => {
  const db = migratedDb();
  seed(db);
  const stranger = {
    message: { message_id: 1, text: "/balance", chat: { id: 999 }, from: { id: 999 } },
  };
  const res = await send(env(db), stranger);

  // 200 on purpose — Telegram retries anything else, and a retry loop on a stranger's update is
  // worse than the update itself. Silence is the whole response.
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [], "nothing may be sent in response to an update from another chat");
});

test("tg: both halves of the door are required", async () => {
  const db = migratedDb();
  seed(db);
  const wrongPath = await send(env(db), textMessage("/balance"), { path: "/not-the-secret" });
  assert.equal(wrongPath.status, 403);

  const wrongHeader = await send(env(db), textMessage("/balance"), { header: "not-the-secret" });
  assert.equal(wrongHeader.status, 403, "the path segment alone must not be enough");
  assert.deepEqual(sent, []);
});

/**
 * §D1 — «відвʼязав» must mean it, for the owner too (2026-08-21).
 *
 * Reported from production: unlinking in the app and then going on using the bot. The cause was
 * that `unlinkTgChat` writes an EMPTY row and both readers treated empty as «never linked», so
 * the owner-only deployment fallback re-granted what the button had just revoked — outbound AND
 * inbound, since `tgTarget` is also the command allowlist. These pin both directions, because a
 * fix to one of them looks complete from either side alone.
 */
import { tgTarget, unlinkTgChat } from "../lib/messaging/tg-target.ts";

test("tg: after unlinking, the deployment chat no longer commands the bot", async () => {
  const db = migratedDb();
  seed(db);
  const e = { ...env(db), TG_CHAT_ID: CHAT };

  await unlinkTgChat(e as never);
  sent = [];

  const res = await send(e, textMessage("/balance"));
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [], "an unlinked chat must not be answered, even the owner's own");

  // The outbound half of the same switch.
  assert.equal(await tgTarget(e as never), null, "and nothing may be pushed there either");
});
