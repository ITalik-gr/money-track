// Encrypted per-user credentials (PLATFORM.md §4).
//
// Threat model, stated so the shape makes sense: the Durable Object already isolates one
// user's rows from another's, so this layer is not about tenant separation. It is about a
// copy of the storage — a backup, an export, a debugging dump — not being a copy of everyone's
// bank tokens. The master key lives only as a Worker secret, so a stolen database is inert.
//
// AES-GCM (authenticated) rather than plain AES: it also detects tampering, and a modified
// ciphertext must fail loudly instead of decrypting to garbage that gets sent to a bank API.
import type { AppDb } from "./db-shim.ts";

export type SecretName = "mono_token" | "anthropic_api_key";
export const SECRET_NAMES: SecretName[] = ["mono_token", "anthropic_api_key"];

export interface SecretStatus {
  name: SecretName;
  set: boolean;
  updated_at: number | null;
  last_ok_at: number | null;
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Derives the AES key from the master secret.
 *
 * SHA-256 of the secret rather than a KDF with a salt: the input is already a
 * high-entropy random Worker secret, not a human password, so stretching buys nothing —
 * and a per-record salt would have to be stored next to the record anyway.
 */
async function aesKey(master: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(master));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function requireMaster(master: string | undefined): string {
  // Failing loudly beats storing plaintext "just this once": a silent fallback would mean
  // the one deployment that forgot the secret is the one with unencrypted bank tokens.
  if (!master) throw new Error("SECRETS_MASTER_KEY is not set — cannot store credentials");
  return master;
}

export async function putSecret(
  db: AppDb,
  master: string | undefined,
  name: SecretName,
  value: string,
  verifiedOk: boolean,
): Promise<void> {
  const key = await aesKey(requireMaster(master));
  // Fresh 12-byte nonce per write. Reusing a nonce with the same key breaks GCM outright.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO user_secrets (name, ciphertext, iv, updated_at, last_ok_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         ciphertext = excluded.ciphertext, iv = excluded.iv,
         updated_at = excluded.updated_at, last_ok_at = excluded.last_ok_at`,
    )
    .bind(name, b64encode(new Uint8Array(ct)), b64encode(iv), now, verifiedOk ? now : null)
    .run();
}

/** Returns the plaintext, or `null` when unset. Decryption failure is `null`, not a throw:
 *  a rotated master key must degrade to "no credential", not to a broken app. */
export async function getSecret(db: AppDb, master: string | undefined, name: SecretName): Promise<string | null> {
  if (!master) return null;
  const row = await db
    .prepare("SELECT ciphertext, iv FROM user_secrets WHERE name = ?")
    .bind(name)
    .first<{ ciphertext: string; iv: string }>();
  if (!row) return null;
  try {
    const key = await aesKey(master);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64decode(row.iv) },
      key,
      b64decode(row.ciphertext),
    );
    return new TextDecoder().decode(pt);
  } catch {
    console.error(`[secrets] cannot decrypt ${name} — master key rotated or data tampered`);
    return null;
  }
}

export async function deleteSecret(db: AppDb, name: SecretName): Promise<void> {
  await db.prepare("DELETE FROM user_secrets WHERE name = ?").bind(name).run();
}

export async function markVerified(db: AppDb, name: SecretName, ok: boolean): Promise<void> {
  await db
    .prepare("UPDATE user_secrets SET last_ok_at = ? WHERE name = ?")
    .bind(ok ? Math.floor(Date.now() / 1000) : null, name)
    .run();
}

/** Status for the UI. Deliberately never includes the value — not even masked. */
export async function secretStatuses(db: AppDb): Promise<SecretStatus[]> {
  const rows = (
    await db.prepare("SELECT name, updated_at, last_ok_at FROM user_secrets").all<{
      name: string;
      updated_at: number;
      last_ok_at: number | null;
    }>()
  ).results;
  const byName = new Map(rows.map((r) => [r.name, r]));
  return SECRET_NAMES.map((name) => {
    const row = byName.get(name);
    return {
      name,
      set: !!row,
      updated_at: row?.updated_at ?? null,
      last_ok_at: row?.last_ok_at ?? null,
    };
  });
}
