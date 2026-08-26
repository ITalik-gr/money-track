// Account self-service: the things a user must be able to do to their OWN account without asking
// the owner (added 2026-07-26, security review).
//
// WHY IT LIVES IN THE WORKER, not in `user-app.ts`: erasure has two halves in two different
// databases — the finance data inside the user's Durable Object, and the identity row in the
// shared directory. Only the Worker can see both. A handler inside the DO could wipe itself and
// leave a directory row pointing at an object that reintroduces itself on the next login.
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { Env } from "../env.ts";
import { CLEAR_COOKIE_OPTS, DEMO_COOKIE, SESSION_COOKIE } from "../lib/platform/auth.ts";
import { bumpTokenVersion, deleteUser, findUserById, issueMcpVersion, revokeMcp } from "../lib/platform/directory.ts";
import { createMcpToken } from "../lib/platform/auth.ts";
import { countUserGrants, deleteUserGrants } from "../lib/platform/oauth-store.ts";
import type { McpStatus, McpToken } from "../../shared/api/index.ts";

export const account = new Hono<{ Bindings: Env; Variables: { userId: string; isOwner: boolean } }>();

/**
 * Sign out of every device (migration 0005).
 *
 * The one action a stateless session could not offer before: `POST /api/logout` clears the
 * cookie in THIS browser, which is useless against a cookie already copied somewhere else.
 * Bumping the generation makes every cookie ever issued to this user fail verification — the
 * honest answer to "I think someone has my session".
 *
 * Effective within 60s on warm isolates, immediately on cold ones: the guard caches the
 * directory row for a minute, and putting a D1 read in front of every API call is the cost
 * this whole design exists to avoid.
 */
account.post("/logout-all", async (c) => {
  const userId = c.get("userId");
  // A sandbox has no directory row to bump; its cookie dies with the sandbox in 24h anyway.
  if (userId.startsWith("demo:")) return c.json({ error: "demo_has_no_account" }, 400);
  await bumpTokenVersion(c.env.DIRECTORY, userId);
  /**
   * The MCP token goes too, and that is the point rather than a side effect. This button is the
   * answer to "I think someone has my credentials"; an answer that leaves a year-long bearer
   * token alive on some machine would be a worse lie than not offering the button at all.
   */
  await revokeMcp(c.env.DIRECTORY, userId);
  await deleteUserGrants(c.env.DIRECTORY, userId);
  setCookie(c, SESSION_COOKIE, "", CLEAR_COOKIE_OPTS);
  setCookie(c, DEMO_COOKIE, "", { ...CLEAR_COOKIE_OPTS, httpOnly: true });
  return c.json({ ok: true });
});

/**
 * Erase this account: finance data first, identity second, session last.
 *
 * Before this existed, the only "removal" was `status='disabled'`, which keeps every transaction,
 * balance and AI note indefinitely — fine as a door lock, wrong as an answer to "delete my data".
 *
 * Irreversible and unauthenticated-by-nobody-else, so it asks for an explicit typed confirmation
 * rather than trusting a button: a stray POST from an old tab must not erase a bank history.
 */
account.post("/delete", async (c) => {
  const userId = c.get("userId");
  if (userId.startsWith("demo:")) {
    // A sandbox erases itself on its 24h alarm; there is no account here to delete.
    return c.json({ error: "demo_has_no_account" }, 400);
  }
  const body = await c.req.json<{ confirm?: string }>().catch(() => ({ confirm: undefined }));
  if (body.confirm !== "DELETE") return c.json({ error: "confirmation_required" }, 400);

  const me = await findUserById(c.env.DIRECTORY, userId);
  if (!me) return c.json({ error: "not_found" }, 404);
  // The owner is the deployment. Deleting that row leaves an app whose only door — the
  // OWNER_EMAIL bootstrap in the OAuth callback — would recreate an empty account, silently
  // "restoring" access to a wiped install. Refuse and let it be a deliberate ops action.
  if (me.is_owner === 1) return c.json({ error: "cannot_delete_owner" }, 400);

  // Data first: if this throws, the account still exists and the user can retry. The reverse
  // order would leave orphaned finance data nobody can reach or erase.
  const ns = c.env.USER_DO;
  await ns.get(ns.idFromName(userId)).reset();
  // The R2 copies go too. A "delete my data" that leaves a fortnight of full dumps in a bucket
  // is not a deletion — and this is the only place that knows the account is going away.
  try {
    const { deleteAllBackups } = await import("../lib/platform/backup.ts");
    await deleteAllBackups(c.env.RECEIPTS, userId);
  } catch (e) {
    console.error("[account] backup cleanup failed:", e instanceof Error ? e.message : e);
  }
  await deleteUser(c.env.DIRECTORY, userId);

  setCookie(c, SESSION_COOKIE, "", CLEAR_COOKIE_OPTS);
  setCookie(c, DEMO_COOKIE, "", { ...CLEAR_COOKIE_OPTS, httpOnly: true });
  return c.json({ ok: true });
});

/**
 * §MCP — a bearer token that lets an MCP client (Claude Code, Claude Desktop via `mcp-remote`)
 * read this account's ledger. Worker-side for the same reason as the rest of this file: the
 * credential's generation lives in the directory, which the Durable Object cannot reach.
 *
 * Deliberately NOT a list of tokens. One credential per account is what makes the screen
 * honest — "connected / not connected", with revoke meaning revoke. A list invites the state
 * where four tokens exist, three of them on machines the owner no longer has.
 */
function mcpUrl(reqUrl: string): string {
  return `${new URL(reqUrl).origin}/mcp`;
}

account.get("/mcp", async (c) => {
  const userId = c.get("userId");
  if (userId.startsWith("demo:")) return c.json({ error: "demo_has_no_account" }, 400);
  const me = await findUserById(c.env.DIRECTORY, userId);
  if (!me) return c.json({ error: "not_found" }, 404);
  return c.json({
    active: me.mcp_issued_at != null,
    // Programs that completed the OAuth consent flow. Counted rather than listed: a client
    // registers itself anew on each reconnect, so a list would name the same editor four times.
    connected_clients: await countUserGrants(c.env.DIRECTORY, userId),
    issued_at: me.mcp_issued_at,
    url: mcpUrl(c.req.url),
  } satisfies McpStatus);
});

/**
 * Mint, or rotate. There is no separate "rotate" verb because issuing is already destructive to
 * the previous token (`issueMcpVersion` bumps the generation): a button that could mint a second
 * live token would quietly turn the one-credential promise above into a list.
 */
account.post("/mcp", async (c) => {
  const userId = c.get("userId");
  // A sandbox lives 24h and is meant to be looked at, not connected to. It also cannot get here:
  // `verifyMcpToken` rejects non-hex ids. Refusing at the source keeps the screen from offering
  // a stranger a credential that would stop working the same day.
  if (userId.startsWith("demo:")) return c.json({ error: "demo_has_no_account" }, 400);
  if (!c.env.SESSION_SECRET && !c.env.APP_PASSWORD) {
    return c.json({ error: "no_signing_key", detail: "SESSION_SECRET is not set" }, 500);
  }
  const version = await issueMcpVersion(c.env.DIRECTORY, userId);
  const token = await createMcpToken(c.env, userId, version);
  const me = await findUserById(c.env.DIRECTORY, userId);
  return c.json({
    token,
    active: true,
    connected_clients: await countUserGrants(c.env.DIRECTORY, userId),
    issued_at: me?.mcp_issued_at ?? Math.floor(Date.now() / 1000),
    url: mcpUrl(c.req.url),
  } satisfies McpToken);
});

account.delete("/mcp", async (c) => {
  const userId = c.get("userId");
  if (userId.startsWith("demo:")) return c.json({ error: "demo_has_no_account" }, 400);
  await revokeMcp(c.env.DIRECTORY, userId);
  /**
   * ⚠️ Bumping the generation is only HALF of a revocation. It expires every access token, but a
   * refresh token is a stored row and would go on minting fresh ones for two months. A button
   * labelled "revoke access" that leaves a working credential behind is worse than no button.
   */
  await deleteUserGrants(c.env.DIRECTORY, userId);
  return c.json({ active: false, connected_clients: 0, issued_at: null, url: mcpUrl(c.req.url) } satisfies McpStatus);
});
