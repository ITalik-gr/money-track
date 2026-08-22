/**
 * The Telegram bot's entry point.
 *
 * This was the last file in `worker/routes/` still holding inline SQL (`ARCHITECTURE.md` §5), and
 * the rule for that tail is that no query moves before something can catch a mistake. Nothing
 * could here, for a structural reason: the handlers are driven by an update PAYLOAD rather than by
 * an HTTP route, and the bot answers by calling the Telegram API over `fetch`. So the observable
 * behaviour is not the response — it is 200 for almost everything — but the OUTGOING calls.
 *
 * Hence the harness below: `fetch` is replaced, every call to `api.telegram.org` is recorded, and
 * the assertions are about what the bot said and which buttons it offered. That is also what makes
 * these tests worth keeping after the refactor — the keyboards are built from category rows, so a
 * query that starts returning income categories, or child categories, or all 45 of them, shows up
 * here as a changed set of buttons rather than as nothing at all.
 *
 * Security is pinned too, and deliberately in the same file: both halves of the door (the secret
 * path segment AND the header) and the chat allowlist are the reason a "blind" update from a
 * stranger never reaches a handler.
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

const callback = (data: string) => ({
  callback_query: {
    id: "cb1", data, from: { id: Number(CHAT) },
    message: { message_id: 7, chat: { id: Number(CHAT) } },
  },
});

/** Every inline button across every call the bot made. */
const buttons = () =>
  sent.flatMap((c) => {
    const kb = (c.body.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard;
    return (kb ?? []).flat();
  });

test("tg: /balance answers with this account's own funds", async () => {
  const db = migratedDb();
  seed(db);
  const res = await send(env(db), textMessage("/balance"));

  assert.equal(res.status, 200);
  const msg = sent.find((c) => c.method === "sendMessage");
  assert.ok(msg, "the bot must answer /balance");
  assert.match(String(msg.body.text), /Власні кошти/);
  assert.equal(String(msg.body.chat_id), CHAT);
});

test("tg: the category keyboard offers top-level EXPENSE categories only", async () => {
  // The keyboard is built from a query, and this is what that query is for: a list that leaked
  // income buckets or sub-categories would be silently wrong — every button still "works".
  const db = migratedDb();
  seed(db);
  // A pending expense is what `tgcat` edits; without one the callback has nothing to re-categorise.
  db.raw.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)").run(
    `tg_pending_${CHAT}`,
    JSON.stringify({ merchant: "Кава", amount: 45, currency_code: 980, category_id: null, note: null, message_id: 7 }),
  );

  await send(env(db), callback("tgcat"));

  const cats = buttons().filter((b) => b.callback_data.startsWith("tgsetcat:"));
  assert.ok(cats.length > 0, "the keyboard must offer categories");

  // `tgsetcat:0` is the explicit "no category" button, not a row in the table.
  const ids = cats.map((b) => Number(b.callback_data.split(":")[1])).filter((n) => n > 0);
  const rows = db.raw.prepare(
    `SELECT id, is_income, parent_id FROM categories WHERE id IN (${ids.map(() => "?").join(",")})`,
  ).all(...(ids as never[])) as { id: number; is_income: number; parent_id: number | null }[];
  assert.equal(rows.length, ids.length, "every button must point at a real category");
  for (const r of rows) {
    assert.equal(r.is_income, 0, `category ${r.id} is an income bucket and must not be offered for an expense`);
    assert.equal(r.parent_id, null, `category ${r.id} is a sub-category; the keyboard is top level`);
  }
});

test("tg: the alert keyboard excludes bucket 13 — a transfer is not a spending category", async () => {
  const db = migratedDb();
  seed(db);
  const txId = (db.raw.prepare("SELECT id FROM transactions ORDER BY id LIMIT 1").get() as { id: string }).id;

  await send(env(db), callback(`al_cat:${txId}:cat`));

  const cats = buttons().filter((b) => b.callback_data.startsWith("al_setcat:"));
  assert.ok(cats.length > 0, "the alert keyboard must offer categories");
  const ids = cats.map((b) => Number(b.callback_data.split(":")[2]));
  assert.ok(!ids.includes(13), "«Перекази і зняття» must never be offered as a real category");
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
 * The bot's own chrome (2026-08-21): the ⌘ command menu and the button strip.
 *
 * Both existed for a day without being visible in production, and the reason was not the code that
 * builds them — it was WHEN it ran. So what these tests pin is the timing: attached from an
 * ordinary update, exactly once, and again when the labels change. A test that only asserted
 * «the strip is well-formed» would have passed on the broken version.
 */
const stripKeyboards = () =>
  sent.filter((c) => (c.body.reply_markup as { keyboard?: unknown } | undefined)?.keyboard);

test("tg: the button strip is attached once per chat, not on every message", async () => {
  const db = migratedDb();
  seed(db);
  const e = env(db);

  await send(e, textMessage("/balance"));
  assert.equal(stripKeyboards().length, 1, "a chat that has never seen the strip must be given it");
  const kb = (stripKeyboards()[0].body.reply_markup as { keyboard: { text: string }[][] }).keyboard;
  assert.equal(kb.flat().length, 8);

  sent = [];
  await send(e, textMessage("/balance"));
  // Re-sending it every time would be noise on a channel people read on a phone — and the marker
  // is what makes the lazy attachment cheap enough to run after every update.
  assert.deepEqual(stripKeyboards(), [], "the strip must not be re-attached to a chat that has it");
});

test("tg: changing the labels re-attaches the strip", async () => {
  // The version is derived FROM the labels, so nobody has to remember to bump it. Simulated here
  // by an older marker, which is exactly what a rename leaves behind for every existing chat.
  const db = migratedDb();
  seed(db);
  db.raw.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)")
    .run(`tg_kb_${CHAT}`, "an-older-set-of-buttons");

  await send(env(db), textMessage("/balance"));
  assert.equal(stripKeyboards().length, 1);
});

test("tg: the ⌘ menu is registered once, and never by a guest object", async () => {
  const db = migratedDb();
  seed(db);
  const e = env(db);

  await send(e, textMessage("/balance"));
  // Two calls: the default list and the Ukrainian one. Telegram picks by interface language.
  assert.equal(sent.filter((c) => c.method === "setMyCommands").length, 2);

  sent = [];
  await send(e, textMessage("/balance"));
  assert.deepEqual(sent.filter((c) => c.method === "setMyCommands"), [],
    "the command list is one resource for the whole bot — registering it per message is waste");

  // A non-owner object must not write it at all: the list belongs to the deployment, and
  // «harmless this time» is how both cross-tenant holes of 2026-07-26 were argued for.
  const other = migratedDb();
  seed(other);
  sent = [];
  await send({ ...env(other), IS_OWNER: false }, textMessage("/balance"));
  assert.deepEqual(sent.filter((c) => c.method === "setMyCommands"), []);
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

test("tg: the chat is told it was unlinked, and an owner who never linked keeps the fallback", async () => {
  const db = migratedDb();
  seed(db);
  const e = { ...env(db), TG_CHAT_ID: CHAT };

  await unlinkTgChat(e as never);
  const notice = sent.find((c) => c.method === "sendMessage");
  // Silence after this looks exactly like a broken bot from inside Telegram — the one place the
  // person now is. Same reasoning as the re-link warning: you cannot undo it, you can say it.
  assert.ok(notice, "the chat that lost the bot must be told");
  assert.match(String(notice.body.text), /відвʼязано|unlinked/i);

  // A fresh object has NO row at all, which is a different fact: the fallback exists for exactly
  // this case, and narrowing it would have taken the bot away from the owner entirely.
  const fresh = migratedDb();
  seed(fresh);
  const target = await tgTarget({ ...env(fresh, false), TG_CHAT_ID: CHAT } as never);
  assert.equal(target?.chatId, CHAT);
});
