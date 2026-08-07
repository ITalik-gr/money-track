/**
 * Web Push (§PUSH).
 *
 * The reason this file exists: a wrong VAPID token does not throw anywhere in our code. The push
 * service answers 401, the browser never rings, and the only symptom is a notification that did
 * not arrive on a night nobody was watching. So the signature is verified here against the public
 * key — the same check the push service does — rather than trusted because it compiled.
 *
 * The subscription lifecycle is pinned for the same class of reason: a 410 that does not delete
 * the row means we push at a dead endpoint forever, and a transient 500 that DOES delete it means
 * someone is silently unsubscribed by one bad night.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, verify as nodeVerify } from "node:crypto";
import { sendWakeups } from "../lib/messaging/webpush.ts";
import * as pushRepo from "../repo/push.ts";
import { migratedDb, testEnv, type MemDb } from "./harness.ts";
import type { Env } from "../env.ts";

const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const toB64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A real P-256 pair in the exact shape the two secrets hold. */
function vapidKeys() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
  const pub = Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]);
  return { publicKey: toB64url(pub), privateKey: jwk.d, jwk };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Captured { url: string; headers: Record<string, string>; body: BodyInit | null | undefined }

/** Replace `fetch` with one that records the push and answers with `status`. */
function capture(status = 201): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    calls.push({ url: String(input), headers, body: init?.body });
    return new Response(null, { status });
  }) as typeof fetch;
  return calls;
}

function envWith(db: MemDb, keys: { publicKey: string; privateKey: string }): Env {
  return {
    ...testEnv(db),
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    OWNER_EMAIL: "owner@example.com",
  } as unknown as Env;
}

async function withSub(endpoint = "https://fcm.googleapis.com/fcm/send/abc123") {
  const db = migratedDb();
  await pushRepo.add(db, endpoint, 1778000000);
  return db;
}

test("push: the VAPID token is a signature the push service can actually verify", async () => {
  const keys = vapidKeys();
  const db = await withSub();
  const calls = capture(201);

  const r = await sendWakeups(envWith(db, keys));
  assert.equal(r.sent, 1);
  assert.equal(calls.length, 1);

  const auth = calls[0].headers.authorization ?? "";
  const jwt = auth.match(/vapid t=([^,]+), k=(.+)/)?.[1];
  const key = auth.match(/vapid t=([^,]+), k=(.+)/)?.[2];
  assert.ok(jwt, `Authorization must carry a token, got: ${auth}`);
  assert.equal(key, keys.publicKey, "the header must advertise the key the token was signed with");

  const [h, p, sig] = jwt.split(".");
  const header = JSON.parse(fromB64url(h).toString()) as { alg: string; typ: string };
  assert.equal(header.alg, "ES256");

  const claims = JSON.parse(fromB64url(p).toString()) as { aud: string; exp: number; sub: string };
  // `aud` is the push service's ORIGIN — a token scoped to the full endpoint would be rejected,
  // and it is the reason one token can serve every subscription on the same service.
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:owner@example.com");
  assert.ok(claims.exp > Math.floor(Date.now() / 1000), "an already-expired token is a silent 401");
  assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 24 * 3600, "the spec caps `exp` at 24h");

  // THE assertion. Web Crypto signs ECDSA as raw r||s; Node verifies DER by default, and getting
  // that wrong is the classic way this ships broken while every test that only parses the JWT passes.
  const pub = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: keys.jwk.x, y: keys.jwk.y },
    format: "jwk",
  });
  const ok = nodeVerify("sha256", Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: "ieee-p1363" }, fromB64url(sig));
  assert.ok(ok, "the push service would reject this signature");
});

test("push: the wake-up carries no payload — by design, not by omission", async () => {
  const keys = vapidKeys();
  const db = await withSub();
  const calls = capture(201);
  await sendWakeups(envWith(db, keys));

  assert.ok(!calls[0].body, "a body here would mean somebody's money is passing through the push service");
  assert.equal(calls[0].headers["content-length"], "0");
  assert.ok(calls[0].headers.ttl, "without a TTL an offline phone gets nothing when it wakes");
});

test("push: a subscription the service reports as GONE is deleted at once", async () => {
  const keys = vapidKeys();
  const db = await withSub();
  capture(410);

  const r = await sendWakeups(envWith(db, keys));
  assert.equal(r.dropped, 1);
  assert.equal(await pushRepo.count(db), 0, "410 is definitive — retrying it for five nights is pointless");
});

test("push: a transient failure does NOT unsubscribe anyone", async () => {
  const keys = vapidKeys();
  const db = await withSub();
  capture(500);

  const r = await sendWakeups(envWith(db, keys));
  assert.equal(r.failed, 1);
  assert.equal(await pushRepo.count(db), 1, "one bad night must not silently turn notifications off");

  // ...but a subscription that never works does eventually go, or the table grows dead rows that
  // are pushed at every single night forever.
  for (let i = 1; i < pushRepo.PUSH_MAX_FAILS; i++) await sendWakeups(envWith(db, keys));
  assert.equal(await pushRepo.count(db), 0);
});

test("push: with no keys configured, nothing is sent and nothing throws", async () => {
  const db = await withSub();
  const calls = capture(201);
  const r = await sendWakeups(testEnv(db) as unknown as Env);
  assert.deepEqual(r, { sent: 0, dropped: 0, failed: 0 });
  assert.equal(calls.length, 0, "a deployment without VAPID keys must not reach the network at all");
});
