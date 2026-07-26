// Owner-only user administration: the whitelist that makes "invite-only" a real thing rather
// than an intention (PLATFORM.md §0.1 — ~10-50 friends, no public sign-up).
//
// Deliberately tiny and directory-only: these endpoints move nobody's money and never touch a
// user's Durable Object. Removing someone is `status='disabled'`, not a delete — their data
// stays in their own DO, and the door simply stops opening.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { deleteUser, findUserById, inviteUser, listUsers, setUserStatus, type UserStatus } from "../lib/platform/directory.ts";

export const admin = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

/**
 * Owner gate. Runs on every route below.
 *
 * Checked against the directory rather than against a claim in the session cookie: ownership
 * has to be revocable, and a cookie minted before a demotion would otherwise still be an
 * owner cookie for the next 30 days.
 */
admin.use("*", async (c, next) => {
  const me = await findUserById(c.env.DIRECTORY, c.get("userId"));
  if (!me || me.is_owner !== 1) return c.json({ error: "owner_only" }, 403);
  await next();
});

admin.get("/users", async (c) => {
  const users = await listUsers(c.env.DIRECTORY);
  return c.json({
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      status: u.status,
      is_owner: u.is_owner === 1,
      created_at: u.created_at,
      last_login_at: u.last_login_at,
    })),
  });
});

admin.post("/users/invite", async (c) => {
  const { email } = await c.req.json<{ email?: string }>().catch(() => ({ email: undefined }));
  // Shape check only. Bouncing a typo'd address is not this endpoint's job — Google decides
  // what a real account is, and an address that never signs in costs one unused row.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "bad_email" }, 400);
  const user = await inviteUser(c.env.DIRECTORY, { email, invitedBy: c.get("userId") });
  return c.json({ ok: true, user: { id: user.id, email: user.email, status: user.status } });
});

/**
 * P0.7 — copies the pre-multi-user D1 database into the owner's Durable Object.
 *
 * Owner-only and deliberately manual: this is the step that decides whether the live app shows
 * the real history or an empty one, and it must be run once, deliberately, with the result
 * read. The response carries before/after counts and sums — `ok:false` means the money did not
 * match and the run must be investigated, not retried blindly.
 */
admin.post("/import-legacy", async (c) => {
  const me = await findUserById(c.env.DIRECTORY, c.get("userId"));
  const ns = c.env.USER_DO;
  const report = await ns.get(ns.idFromName(me!.id)).importLegacyData();
  return c.json(report, report.ok ? 200 : 409);
});

/**
 * Erase a user completely: their finance database, then their identity row.
 *
 * `status='disabled'` keeps everything forever, which is right for "revoke access" and wrong for
 * "this person left, stop holding their bank history". Until 2026-07-26 only the former existed,
 * so there was no way — for the owner OR the user — to get data out of this deployment.
 */
admin.delete("/users/:id", async (c) => {
  const id = c.req.param("id");
  const target = await findUserById(c.env.DIRECTORY, id);
  if (!target) return c.json({ error: "not_found" }, 404);
  if (target.is_owner === 1) return c.json({ error: "cannot_delete_owner" }, 400);
  // Data first, identity second: a failure between the two leaves an unreachable account rather
  // than a live account whose data silently vanished.
  const ns = c.env.USER_DO;
  await ns.get(ns.idFromName(id)).reset();
  await deleteUser(c.env.DIRECTORY, id);
  return c.json({ ok: true });
});

admin.post("/users/:id/status", async (c) => {
  const id = c.req.param("id");
  const { status } = await c.req.json<{ status?: string }>().catch(() => ({ status: undefined }));
  if (status !== "invited" && status !== "active" && status !== "disabled") {
    return c.json({ error: "bad_status" }, 400);
  }
  const target = await findUserById(c.env.DIRECTORY, id);
  if (!target) return c.json({ error: "not_found" }, 404);
  // The owner cannot lock themselves out: there is no second owner to undo it, and recovery
  // would mean hand-editing the directory database.
  if (target.is_owner === 1 && status === "disabled") return c.json({ error: "cannot_disable_owner" }, 400);
  await setUserStatus(c.env.DIRECTORY, id, status as UserStatus);
  return c.json({ ok: true });
});
