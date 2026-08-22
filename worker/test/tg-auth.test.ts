/**
 * Signing in from a Telegram Mini App.
 *
 * The verification is the whole feature, and it is the kind of code that fails SILENTLY when
 * wrong: derive the key the other way round, or forget to drop a field from the check-string, and
 * you still get a 64-character hex string — it just never matches, so «nobody can sign in» and
 * «anybody can sign in» are one typo apart and neither announces itself.
 *
 * So the fixture below builds `initData` with node's `crypto`, from the SPEC, rather than by
 * calling the code under test. Two independent implementations agreeing about the order of the
 * two HMACs and the shape of the check-string is the actual assertion here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyInitData } from "../lib/platform/tg-auth.ts";

const TOKEN = "123456:test-bot-token";

/** Telegram's scheme, written out from the documentation. */
function signInitData(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  const p = new URLSearchParams(fields);
  p.set("hash", hash);
  return p.toString();
}

const NOW = 1_780_000_000_000;
/** `at` defaults to the fixed clock the unit tests use; the ROUTE has no clock injection, so its
 *  tests pass the real one — a payload minted three months ago is expired, correctly. */
const fresh = (extra: Record<string, string> = {}, at = NOW) => ({
  auth_date: String(Math.floor(at / 1000) - 30),
  query_id: "AAF",
  user: JSON.stringify({ id: 424242, first_name: "Test" }),
  ...extra,
});

test("a genuine launch payload names its user", async () => {
  const user = await verifyInitData(TOKEN, signInitData(fresh()), NOW);
  assert.equal(user?.id, 424242);
});

test("a payload signed with a different bot token is refused", async () => {
  // The bot token IS the shared secret. Anyone able to forge this could sign in as any linked
  // account, so this is the single most important negative in the file.
  const forged = signInitData(fresh(), "999:some-other-bot");
  assert.equal(await verifyInitData(TOKEN, forged, NOW), null);
});

test("changing any field after signing invalidates it", async () => {
  const data = signInitData(fresh());
  const tampered = data.replace(/user=[^&]*/, `user=${encodeURIComponent(JSON.stringify({ id: 1, first_name: "Someone else" }))}`);
  assert.equal(await verifyInitData(TOKEN, tampered, NOW), null);
});

test("a signature does not expire on its own, so `auth_date` is checked", async () => {
  const old = signInitData({ ...fresh(), auth_date: String(Math.floor(NOW / 1000) - 86400 - 60) });
  assert.equal(await verifyInitData(TOKEN, old, NOW), null);

  // Just inside the window still works — the window exists to bound replay, not to sign people
  // out of a Mini App they left open.
  const yesterday = signInitData({ ...fresh(), auth_date: String(Math.floor(NOW / 1000) - 86000) });
  assert.equal((await verifyInitData(TOKEN, yesterday, NOW))?.id, 424242);
});

test("a future `auth_date` is refused", async () => {
  // The signature says nothing about the clock, and data dated forward would outlive its window
  // in the one direction the age check cannot see.
  const ahead = signInitData({ ...fresh(), auth_date: String(Math.floor(NOW / 1000) + 3600) });
  assert.equal(await verifyInitData(TOKEN, ahead, NOW), null);
});

test("`signature` is PART of the check-string", async () => {
  /**
   * Reported 2026-08-22: the Mini App answered `bad_init_data` to every launch. Bot API 8.0 added
   * a `signature` field, every current client sends it, and this code was dropping it from the
   * check-string — so the hash never matched and the feature was dead on arrival for everyone.
   *
   * Telegram excludes `signature` in ONE place only: the separate Ed25519 scheme a third party
   * uses to validate without the bot token. The bot-token HMAC signs «all received fields», and a
   * `signature` that arrived IS one (aiogram and @telegram-apps both pop `hash` and nothing else).
   *
   * ⚠️ The previous version of this test appended `&signature=…` AFTER signing, so the field was
   * outside the fixture's own hash — it asserted the code's guess back to itself and passed either
   * way. Here the fixture signs it like Telegram does, which is the only version that can fail.
   */
  const signed = signInitData(fresh({ signature: "3rd_party_ed25519_sig" }));
  assert.equal((await verifyInitData(TOKEN, signed, NOW))?.id, 424242);

  // And the mirror: a `signature` bolted on after the fact is not covered by the hash, so the
  // payload has been altered and must be refused.
  const bolted = signInitData(fresh()) + "&signature=3rd_party_ed25519_sig";
  assert.equal(await verifyInitData(TOKEN, bolted, NOW), null);
});

test("garbage in, null out — never a throw", async () => {
  for (const bad of ["", "hash=", "not even a query string", "hash=zz&auth_date=x"]) {
    assert.equal(await verifyInitData(TOKEN, bad, NOW), null, bad);
  }
  assert.equal(await verifyInitData("", signInitData(fresh()), NOW), null, "no bot token, no answer");
  // A payload with a valid signature but no `user` cannot name anybody, so it cannot sign anybody in.
  const noUser = signInitData({ auth_date: String(Math.floor(NOW / 1000)), query_id: "AAF" });
  assert.equal(await verifyInitData(TOKEN, noUser, NOW), null);
});

/**
 * The door itself. What matters here is not that a valid payload works — it is that a valid
 * payload from somebody who never linked their chat gets NOTHING. This endpoint mints a 30-day
 * session, and the only thing standing between «I have a Telegram account» and «I am this user»
 * is the `tg_links` row.
 */
import { auth } from "../routes/auth.ts";
import { migratedDirectoryDb, type MemDb } from "./harness.ts";
import { ensureOwner, linkTgChatToUser, setUserStatus } from "../lib/platform/directory.ts";

const asD1 = (m: MemDb) => m as unknown as D1Database;

async function post(dir: MemDb, initData: string, extra: Record<string, unknown> = {}) {
  return auth.request("/miniapp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ init_data: initData }),
  }, { DIRECTORY: asD1(dir), TG_BOT_TOKEN: TOKEN, SESSION_SECRET: "s3cret", ...extra });
}

test("miniapp: a linked Telegram signs in; an unlinked one is told to link, not let in", async () => {
  const dir = migratedDirectoryDb();
  const owner = await ensureOwner(asD1(dir), "owner@example.com");

  const unlinked = await post(dir, signInitData(fresh({}, Date.now())));
  assert.equal(unlinked.status, 403);
  assert.equal(((await unlinked.json()) as { error: string }).error, "not_linked");
  assert.equal(unlinked.headers.get("set-cookie"), null, "a refusal must not mint a session");

  await linkTgChatToUser(asD1(dir), "424242", owner.id, 1_780_000_000);
  const ok = await post(dir, signInitData(fresh({}, Date.now())));
  assert.equal(ok.status, 200);
  // `__Host-` is not decoration: it forces Secure, Path=/ and NO Domain, which is what stops
  // anything on a neighbouring subdomain planting a session here.
  assert.match(ok.headers.get("set-cookie") ?? "", /__Host-mt_session=/);
});

test("miniapp: a disabled account cannot come in through the second door", async () => {
  // §REVOKE — a ban has to hold on every entrance, not the one it was written for.
  const dir = migratedDirectoryDb();
  const owner = await ensureOwner(asD1(dir), "owner@example.com");
  await linkTgChatToUser(asD1(dir), "424242", owner.id, 1_780_000_000);
  await setUserStatus(asD1(dir), owner.id, "disabled");

  const res = await post(dir, signInitData(fresh({}, Date.now())));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("miniapp: an unsigned or expired payload never reaches the directory", async () => {
  const dir = migratedDirectoryDb();
  const owner = await ensureOwner(asD1(dir), "owner@example.com");
  await linkTgChatToUser(asD1(dir), "424242", owner.id, 1_780_000_000);

  const forged = await post(dir, signInitData(fresh({}, Date.now()), "999:another-bot"));
  assert.equal(forged.status, 401, "the signature is checked before anything is looked up");
  assert.equal(forged.headers.get("set-cookie"), null);
});


test("miniapp: the owner's deployment chat signs in without a `tg_links` row", async () => {
  /**
   * Reported the day after this endpoint shipped: the Mini App told the OWNER their Telegram was
   * not linked, while their bot answered `/balance` perfectly. A row is written by the signed
   * `/start` deep link, and the owner never needs one — the Worker routes their chat by
   * `TG_CHAT_ID` alone. So the index can be empty for an account whose bot demonstrably works,
   * and every reader that consults only the index concludes there is no link. Exactly the shape
   * of the unlink bug fixed one day earlier, in the opposite direction.
   */
  const dir = migratedDirectoryDb();
  await ensureOwner(asD1(dir), "owner@example.com");

  const res = await post(dir, signInitData(fresh({}, Date.now())), { TG_CHAT_ID: "424242", OWNER_EMAIL: "owner@example.com" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie") ?? "", /__Host-mt_session=/);

  // And it is the OWNER's chat only. A deployment secret is never everyone's fallback (§Безпека) —
  // this is the rule that has been broken twice in this codebase, both times cross-tenant.
  const stranger = signInitData({ ...fresh({}, Date.now()), user: JSON.stringify({ id: 999999, first_name: "Someone" }) });
  const no = await post(dir, stranger, { TG_CHAT_ID: "424242", OWNER_EMAIL: "owner@example.com" });
  assert.equal(no.status, 403);
  assert.equal(no.headers.get("set-cookie"), null);
});
