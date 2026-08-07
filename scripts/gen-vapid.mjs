#!/usr/bin/env node
/**
 * Generate the VAPID keypair for Web Push, once per deployment.
 *
 * Run it, then paste each value into `npx wrangler secret put …`. The keys are NOT written to a
 * file and NOT committed: the private one signs pushes on our behalf, and this repository is
 * public.
 *
 * ⚠️ Generating a NEW pair silently unsubscribes everyone. A browser's subscription is bound to
 * the public key it was created with, so after a rotation every existing endpoint keeps returning
 * 201 while the browser ignores the push. Nothing fails loudly — which is exactly why this warning
 * is here rather than in a doc.
 *
 * Format matches what both sides need without conversion: the public key is the uncompressed P-256
 * point (`0x04 || X || Y`) the browser wants as `applicationServerKey`, and the private key is the
 * raw scalar `d`. See `worker/lib/messaging/webpush.ts`.
 */
import { generateKeyPairSync } from "node:crypto";

// The PRIVATE key's JWK already carries the public coordinates (x, y) alongside the scalar (d), so
// one export gives everything and the two halves cannot be mismatched.
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });

const fromB64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const toB64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The browser rejects anything but the 65-byte uncompressed point, so it is assembled here rather
// than leaving the caller to work out that a JWK's x and y have to be concatenated behind a 0x04.
const raw = Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]);

console.log("VAPID_PUBLIC_KEY  =", toB64url(raw));
console.log("VAPID_PRIVATE_KEY =", jwk.d);
console.log();
console.log("Set them as Worker secrets (they are never stored in the repo):");
console.log("  npx wrangler secret put VAPID_PUBLIC_KEY");
console.log("  npx wrangler secret put VAPID_PRIVATE_KEY");
