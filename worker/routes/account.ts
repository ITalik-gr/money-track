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
import { DEMO_COOKIE, SESSION_COOKIE } from "../lib/platform/auth.ts";
import { deleteUser, findUserById } from "../lib/platform/directory.ts";

export const account = new Hono<{ Bindings: Env; Variables: { userId: string; isOwner: boolean } }>();

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
  await deleteUser(c.env.DIRECTORY, userId);

  setCookie(c, SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  setCookie(c, DEMO_COOKIE, "", { path: "/", maxAge: 0 });
  return c.json({ ok: true });
});
