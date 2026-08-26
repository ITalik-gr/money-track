/**
 * §MCP-OAUTH — the three tables (directory 0010), and nothing else.
 *
 * Lives beside `directory.ts` rather than inside it because that file answers exactly one
 * question — "who is this, and are they allowed in?" — while this one is about grants a user has
 * handed to a program. Keeping them apart is what stops an identity lookup from quietly growing a
 * join against a client registry.
 */
import { randomToken, sha256Hex, CODE_TTL_SEC, REFRESH_TTL_SEC } from "./oauth.ts";

export interface OauthClient {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  created_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * Cap on stored registrations.
 *
 * Claude registers a NEW client on every fresh connection (its own documentation says so and
 * recommends CIMD for high-traffic servers to avoid it). On a personal deployment that means the
 * table grows with reconnects for as long as the app lives, so registration prunes the oldest
 * rows that nothing is using. Pruning at WRITE time rather than in the nightly cron on purpose:
 * the growth is caused by this endpoint, and a cleanup that runs somewhere else is a cleanup that
 * gets disabled without anyone connecting the two.
 */
const MAX_CLIENTS = 200;

export async function registerClient(
  db: D1Database, name: string | null, redirectUris: string[],
): Promise<OauthClient> {
  const client: OauthClient = {
    client_id: randomToken(), client_name: name, redirect_uris: redirectUris, created_at: now(),
  };
  await db.prepare(
    "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)",
  ).bind(client.client_id, name, JSON.stringify(redirectUris), client.created_at).run();
  // Keep the newest MAX_CLIENTS. `COALESCE(last_used_at, created_at)` so a client that connected
  // once long ago and is still in use outranks a fresher registration that was abandoned.
  await db.prepare(
    `DELETE FROM oauth_clients WHERE client_id IN (
       SELECT client_id FROM oauth_clients
       ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT -1 OFFSET ?)`,
  ).bind(MAX_CLIENTS).run();
  return client;
}

export async function findClient(db: D1Database, clientId: string): Promise<OauthClient | null> {
  const row = await db.prepare(
    "SELECT client_id, client_name, redirect_uris, created_at FROM oauth_clients WHERE client_id = ?",
  ).bind(clientId).first<{ client_id: string; client_name: string | null; redirect_uris: string; created_at: number }>();
  if (!row) return null;
  let uris: string[] = [];
  try { uris = JSON.parse(row.redirect_uris) as string[]; } catch { uris = []; }
  return { client_id: row.client_id, client_name: row.client_name, redirect_uris: uris, created_at: row.created_at };
}

export async function touchClient(db: D1Database, clientId: string): Promise<void> {
  await db.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?").bind(now(), clientId).run();
}

export interface CodeRecord {
  user_id: string; client_id: string; redirect_uri: string;
  code_challenge: string; resource: string; scope: string;
}

export async function issueCode(db: D1Database, rec: CodeRecord): Promise<string> {
  const code = randomToken();
  await db.prepare(
    `INSERT INTO oauth_codes (code, user_id, client_id, redirect_uri, code_challenge, resource, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    code, rec.user_id, rec.client_id, rec.redirect_uri, rec.code_challenge,
    rec.resource, rec.scope, now() + CODE_TTL_SEC,
  ).run();
  // Opportunistic sweep of expired codes, for the same reason the client prune sits here.
  await db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(now() - 3600).run();
  return code;
}

/**
 * Redeem a code — ONCE.
 *
 * The `used_at IS NULL` predicate is inside the UPDATE rather than being a read-then-write, so two
 * simultaneous redemptions cannot both see an unused row. A code that is replayed after a leak has
 * to lose, and losing must not depend on timing.
 */
export async function redeemCode(db: D1Database, code: string): Promise<CodeRecord | null> {
  const res = await db.prepare(
    "UPDATE oauth_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at >= ?",
  ).bind(now(), code, now()).run();
  if (!res.meta.changes) return null;
  const row = await db.prepare(
    "SELECT user_id, client_id, redirect_uri, code_challenge, resource, scope FROM oauth_codes WHERE code = ?",
  ).bind(code).first<CodeRecord>();
  return row ?? null;
}

export interface Grant {
  id: string; user_id: string; client_id: string; scope: string; resource: string;
}

/** Mint a refresh token and store only its hash. Returns the token — the one time it exists. */
export async function createGrant(
  db: D1Database, g: Omit<Grant, "id">,
): Promise<{ id: string; refreshToken: string }> {
  const id = randomToken();
  const refreshToken = randomToken();
  await db.prepare(
    `INSERT INTO oauth_grants (id, user_id, client_id, refresh_hash, scope, resource, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, g.user_id, g.client_id, await sha256Hex(refreshToken), g.scope, g.resource,
    now(), now() + REFRESH_TTL_SEC,
  ).run();
  return { id, refreshToken };
}

/**
 * Rotate: the presented refresh token is exchanged for a new one on the SAME grant.
 *
 * OAuth 2.1 requires rotation for public clients, and Claude registers as one. The old hash is
 * overwritten in the same statement that matches it, so the token just used stops working the
 * instant the new one is handed out — a window where both work is a window where a stolen refresh
 * token keeps its value.
 */
export async function rotateGrant(
  db: D1Database, presented: string,
): Promise<{ grant: Grant; refreshToken: string } | null> {
  const hash = await sha256Hex(presented);
  const row = await db.prepare(
    "SELECT id, user_id, client_id, scope, resource FROM oauth_grants WHERE refresh_hash = ? AND expires_at >= ?",
  ).bind(hash, now()).first<Grant>();
  if (!row) return null;
  const next = randomToken();
  const res = await db.prepare(
    "UPDATE oauth_grants SET refresh_hash = ?, last_used_at = ?, expires_at = ? WHERE refresh_hash = ?",
  ).bind(await sha256Hex(next), now(), now() + REFRESH_TTL_SEC, hash).run();
  // Lost a race against another rotation of the same token: whoever wrote first owns the grant.
  if (!res.meta.changes) return null;
  return { grant: row, refreshToken: next };
}

/**
 * Drop every grant a user has handed out. Called by "revoke access" and by "sign out everywhere".
 *
 * ⚠️ Bumping `mcp_version` alone would NOT be enough: that kills access tokens (they carry the
 * generation) but a refresh token is a stored row, and it would go on minting new ones. Both
 * halves, or the button is a lie.
 */
export async function deleteUserGrants(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM oauth_grants WHERE user_id = ?").bind(userId).run();
}

/** How many programs currently hold access — the only honest thing to show on a settings card. */
export async function countUserGrants(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ? AND expires_at >= ?",
  ).bind(userId, now()).first<{ n: number }>();
  return row?.n ?? 0;
}
