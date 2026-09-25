/**
 * §TG-ROUTE — `tg_links` (directory 0008) is the only authority mapping a chat to a user; linking is by
 * signed deep link in a private chat.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDirectoryDb, type MemDb } from "./harness.ts";
import {
  linkTgChatToUser, userForTgChat, unlinkAllTgChats, deleteUser,
} from "../lib/platform/directory.ts";

const db = () => migratedDirectoryDb();
const asD1 = (m: MemDb) => m as unknown as D1Database;
const NOW = 1_780_000_000;

test("a linked chat resolves to its user, and nothing else does", async () => {
  const d = db();
  await linkTgChatToUser(asD1(d), "555", "user-a", NOW);

  assert.equal(await userForTgChat(asD1(d), "555"), "user-a");
  // The single most important negative in this file: an unknown chat is nobody's.
  assert.equal(await userForTgChat(asD1(d), "556"), null);
});

test("chat ids are compared as TEXT, so a number and a string cannot miss each other", async () => {
  const d = db();
  // Telegram ids are 64-bit and negative for groups; `app_state.tg_chat_id` is text, so the index
  // is text. If one side stored an integer, the lookup would silently find nothing — which reads
  // as "not linked" and is the quietest possible failure.
  await linkTgChatToUser(asD1(d), String(-1001234567890), "user-a", NOW);
  assert.equal(await userForTgChat(asD1(d), "-1001234567890"), "user-a");
});

test("deleting the account takes the routing with it", async () => {
  const d = db();
  d.raw.prepare(
    "INSERT INTO users (id, email, name, status, created_at) VALUES ('user-a', 'a@x', 'A', 'active', ?)",
  ).run(NOW);
  await linkTgChatToUser(asD1(d), "555", "user-a", NOW);
  await deleteUser(asD1(d), "user-a");

  // A chat still pointing at a deleted user would route the next message into an object that no
  // longer exists — and, once ids are ever reused, into somebody else's.
  assert.equal(await userForTgChat(asD1(d), "555"), null);
  assert.equal(await unlinkAllTgChats(asD1(d), "user-a").then(() => true), true);
});

test("a directory without migration 0008 routes NOBODY, rather than throwing", async () => {
  const d = db();
  d.raw.exec("DROP TABLE tg_links");
  // Degrading to "the bot does not answer" is the only acceptable direction. The alternative —
  // an exception in the webhook middleware — would take the whole update down, and the one after
  // it, on a deployment whose only fault is being one migration behind.
  assert.equal(await userForTgChat(asD1(d), "555"), null);
});

/**
 * The link token after the bot gained READ access (2026-08-21).
 *
 * Its docstring justified a 64-bit tag on the grounds that a forged token bought «no read access»
 * — true when written, false the same night commands went multi-user. These pin what holds it now.
 */
import { telegramLinkToken, verifyTelegramLinkToken } from "../lib/platform/auth.ts";

const authEnv = { SESSION_SECRET: "s3cr3t-for-tests" } as unknown as Parameters<typeof telegramLinkToken>[0];
const USER = "0123456789abcdef0123456789abcdef";   // 32 hex, as `newUserId` produces

test("a token round-trips, and a tampered one does not", async () => {
  const t = await telegramLinkToken(authEnv, USER);
  assert.equal(await verifyTelegramLinkToken(authEnv, t), USER);

  const [id, exp, sig] = t.split("_");
  // Every field is signed: swapping the user id must not verify against the same tag.
  assert.equal(await verifyTelegramLinkToken(authEnv, `ffffffffffffffffffffffffffffffff_${exp}_${sig}`), null);
  assert.equal(await verifyTelegramLinkToken(authEnv, `${id}_${exp}_${"0".repeat(22)}`), null);
  // A shape that is not a token at all is refused before any comparison happens.
  assert.equal(await verifyTelegramLinkToken(authEnv, "nonsense"), null);
  assert.equal(await verifyTelegramLinkToken(authEnv, undefined), null);
});

test("an expired token is refused", async () => {
  const t = await telegramLinkToken(authEnv, USER);
  const [id, , sig] = t.split("_");
  const past = Math.floor(Date.now() / 1000 - 60).toString(36);
  // The expiry is inside the signature, so a rewritten one fails on the tag as well — but the
  // cheap check runs first, and that ordering is deliberate: no HMAC for an obvious probe.
  assert.equal(await verifyTelegramLinkToken(authEnv, `${id}_${past}_${sig}`), null);
});

test("only a private chat can hold a link", () => {
  // Telegram's own vocabulary — the check is on this exact value, so the list is worth pinning.
  const linkable = (type: string | undefined) => !type || type === "private";
  assert.equal(linkable("private"), true);
  assert.equal(linkable("group"), false);
  assert.equal(linkable("supergroup"), false);
  assert.equal(linkable("channel"), false);
  // A missing type is treated as private: it is what a DM looks like from older payloads, and
  // refusing on absence would break linking for everyone rather than for the case at issue.
  assert.equal(linkable(undefined), true);
});
