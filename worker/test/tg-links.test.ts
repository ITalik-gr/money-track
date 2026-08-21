/**
 * The Telegram chat index (directory 0008) — what makes the bot multi-user.
 *
 * Outbound pushes have been personal since §D1 (2026-08-01). Inbound COMMANDS could not follow,
 * because an update arrives at the Worker from an arbitrary chat and the Worker must pick a
 * Durable Object BEFORE any per-user state is reachable: `idFromName` is one-way, and
 * `app_state.tg_chat_id` lives inside the object you are trying to choose. So the answer has to
 * be in the shared directory, and that is this table.
 *
 * ⚠️ The security shape changed with it. Every unclaimed update used to fall through to the
 * OWNER's object — safe only because the bot then refused to answer anyone but the owner. With
 * real routing the refusal has to move to the router, and the failure mode if it does not is not
 * "the bot is rude", it is "a stranger's message wakes somebody's finances". Hence the last two
 * scenarios: an unknown chat resolves to nobody, and a missing table resolves to nobody too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDirectoryDb, type MemDb } from "./harness.ts";
import {
  linkTgChatToUser, userForTgChat, unlinkTgChatRow, unlinkAllTgChats, deleteUser,
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

test("re-linking a chat moves it, rather than failing or duplicating", async () => {
  const d = db();
  await linkTgChatToUser(asD1(d), "555", "user-a", NOW);
  await linkTgChatToUser(asD1(d), "555", "user-b", NOW + 60);
  assert.equal(await userForTgChat(asD1(d), "555"), "user-b");
  // A shared phone or a re-created account is legitimate; the last `/start` to prove ownership
  // wins, and the proof is the signature the Worker already checked.
  const rows = d.raw.prepare("SELECT COUNT(*) AS n FROM tg_links").get() as { n: number };
  assert.equal(rows.n, 1);
});

test("one user may hold several chats, and unlinking one leaves the others", async () => {
  const d = db();
  await linkTgChatToUser(asD1(d), "1", "user-a", NOW);
  await linkTgChatToUser(asD1(d), "2", "user-a", NOW);
  await unlinkTgChatRow(asD1(d), "1");
  assert.equal(await userForTgChat(asD1(d), "1"), null);
  assert.equal(await userForTgChat(asD1(d), "2"), "user-a");
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
 * The bot speaks the READER's language and prints the READER's currency.
 *
 * A budget, not a spot check. Every earlier fix in this family was found by a person noticing one
 * wrong string, and the next one would be found the same way: the surface is forty messages and
 * nobody re-reads it. So the test is over the FILE — Cyrillic prose in the bot's own source is
 * the defect, and prose is what the budget can see.
 *
 * ⚠️ Kept below a small non-zero budget rather than zero: comments in this repository are
 * historically Ukrainian and are data about WHY, not text anyone receives. What is forbidden is a
 * Cyrillic string LITERAL, which is by construction something a user reads.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { st } from "../lib/platform/i18n.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** String and template literals only — comments are excluded by construction. */
function cyrillicLiterals(file: string): string[] {
  const text = readFileSync(join(SRC, file), "utf8");
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  return [...withoutComments.matchAll(/"[^"\n]*"|`[^`\n]*`/g)]
    .map((m) => m[0])
    .filter((lit) => /[Ѐ-ӿ]/.test(lit))
    // Locale TAGS are data, not prose: `toLocaleDateString("uk-UA")` names a locale.
    .filter((lit) => !/^["`]uk(-UA)?["`]$/.test(lit));
}

test("the Telegram surface carries no Ukrainian string literals", () => {
  for (const file of [
    "routes/telegram.ts",
    "lib/messaging/alert.ts",
    "lib/messaging/proactive.ts",
  ]) {
    assert.deepEqual(cyrillicLiterals(file), [],
      `${file} still writes Ukrainian directly. Every user-facing string goes through st().`);
  }
});

test("both halves of every bot string exist and differ", () => {
  // A key whose `en` is a copy of its `uk` is an untranslated string wearing the shape of a
  // translated one — the failure mode a parity check alone cannot see.
  const keys = ["tgHelp", "tgOwnFunds", "tgNoTx", "tgSavedAs", "tgChatLinked", "tgBudgetOver"] as const;
  for (const k of keys) {
    const uk = st("uk", k, { amount: "1", merchant: "m", months: 1, name: "n", note: "x" });
    const en = st("en", k, { amount: "1", merchant: "m", months: 1, name: "n", note: "x" });
    assert.ok(uk.length > 0 && en.length > 0, `${k} is empty in one language`);
    assert.notEqual(uk, en, `${k} is identical in both languages — probably untranslated`);
    assert.ok(!/[Ѐ-ӿ]/.test(en), `${k}.en still contains Cyrillic`);
  }
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

test("the token fits Telegram's 64-character ?start= budget", async () => {
  const t = await telegramLinkToken(authEnv, USER);
  // The whole reason the tag is truncated at all. Exceeding it does not error — Telegram simply
  // drops the payload, and the link silently does nothing.
  assert.ok(t.length <= 64, `token is ${t.length} chars`);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(t), "and uses only characters ?start= permits");
});

test("the tag is 88 bits, not 64", async () => {
  const t = await telegramLinkToken(authEnv, USER);
  const tag = t.split("_")[2];
  // Free strengthening inside the same budget: 22 hex chars rather than 16. Not a fix for the
  // expired rationale — that is what the rebind warning is for — but there was no reason to leave
  // 24 bits on the table once the token started granting read access.
  assert.equal(tag.length, 22);
});

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

/**
 * A deep link is a BEARER token, so where it is pressed decides who reads the account.
 *
 * Found 2026-08-21 the morning after inbound routing shipped. Pressing the link inside a group
 * used to succeed: the row went into `tg_links`, `app_state.tg_chat_id` became the group, and
 * every push from then on — a budget warning with amounts, a significant-operation alert with the
 * merchant and the sum, the weekly digest — landed in a chat full of other people. Commands
 * stayed silent, because the allowlist happens to require `fromId === chatId`, true only in a DM.
 * So the single visible symptom was «the bot ignores me», while it published the owner's finances.
 */
test("the refusal names the reason, in both languages", () => {
  for (const loc of ["uk", "en"] as const) {
    const msg = st(loc, "tgLinkPrivateOnly");
    assert.ok(msg.length > 40, "a bare «no» teaches nothing");
    // The reason has to be the CONSEQUENCE, not the rule: «only in a private chat» invites a
    // retry, «everyone here would see your balances» explains why there is no way round it.
    assert.match(msg, loc === "uk" ? /баланс/i : /balance/i);
  }
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
