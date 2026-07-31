// Directory access: identity and invites, the only data shared across users.
//
// Everything here answers exactly one question — "who is this, and are they allowed in?" —
// and then hands back a `userId`, which is also the name of that user's Durable Object.
// Nothing financial passes through this module; see migrations-directory/0001_directory.sql.

export type UserStatus = "invited" | "active" | "disabled";

export interface DirectoryUser {
  id: string;
  email: string;
  google_sub: string | null;
  name: string | null;
  picture: string | null;
  status: UserStatus;
  is_owner: number;
  invited_by: string | null;
  created_at: number;
  last_login_at: number | null;
  // Activity counters (migration 0004). All nullable: a user who has not been active since the
  // migration has never reported, and "unknown" must not render as "zero" — those are different
  // facts, and the second one would read as "this person never used it".
  last_seen_at: number | null;
  tx_count: number | null;
  accounts_count: number | null;
  has_mono_key: number | null;
  has_ai_key: number | null;
  stats_at: number | null;
}

/** What a user's Durable Object reports about itself. Volume only — never amounts. */
export interface UserStats {
  tx_count: number;
  accounts_count: number;
  has_mono_key: boolean;
  has_ai_key: boolean;
}

/**
 * Emails are stored and compared lower-cased in JS rather than via SQLite's NOCASE, which
 * only folds ASCII. Gmail addresses are ASCII in practice, but this project has already
 * been burnt once by assuming SQLite case-folding is universal (Cyrillic search), so the
 * normalisation is done where it is guaranteed to work.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase("en");
}

/** Opaque, URL-safe id. Doubles as the Durable Object name, so it must never be reused. */
export function newUserId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function findUserByGoogleSub(db: D1Database, sub: string): Promise<DirectoryUser | null> {
  return db.prepare("SELECT * FROM users WHERE google_sub = ?").bind(sub).first<DirectoryUser>();
}

export async function findUserByEmail(db: D1Database, email: string): Promise<DirectoryUser | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(normalizeEmail(email)).first<DirectoryUser>();
}

export async function findUserById(db: D1Database, id: string): Promise<DirectoryUser | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<DirectoryUser>();
}

export interface InviteInput {
  email: string;
  invitedBy?: string | null;
  isOwner?: boolean;
}

/** Whitelists an email. Idempotent: inviting an existing address returns the existing row. */
export async function inviteUser(db: D1Database, input: InviteInput): Promise<DirectoryUser> {
  const email = normalizeEmail(input.email);
  const existing = await findUserByEmail(db, email);
  if (existing) return existing;
  const id = newUserId();
  await db
    .prepare(
      `INSERT INTO users (id, email, status, is_owner, invited_by, created_at)
       VALUES (?, ?, 'invited', ?, ?, ?)`,
    )
    .bind(id, email, input.isOwner ? 1 : 0, input.invitedBy ?? null, Math.floor(Date.now() / 1000))
    .run();
  return (await findUserById(db, id))!;
}

/** Why a sign-in was refused, so the caller can say something true instead of "not invited". */
export type LoginRefusal = "not_invited" | "disabled";

/**
 * Binds a Google identity to a directory row and marks the session.
 *
 * `allowSignup` decides what happens for an address nobody has invited:
 *   • omitted — invite-only, the original behaviour, kept as a kill switch (`SIGNUP=invite`).
 *   • a predicate (the default deployment mode since 2026-07-31) — consulted ONLY when a row is
 *     about to be created, and a `true` answer opens the door. Passing a predicate rather than a
 *     boolean is what keeps the daily signup ceiling honest: it is charged for new accounts, not
 *     for every returning user's sign-in.
 *
 * The Durable Object is made lazily on the first request, so an account nobody ever uses costs
 * nothing beyond one directory row.
 *
 * Either way this is the ONE place the door is guarded, so there is a single spot to audit
 * (PLATFORM.md §0.2: the demo is its own circuit rather than an exception threaded through
 * every check). `disabled` is always refused — that is the ban, and open signup must not
 * quietly re-admit someone who was shown out.
 */
export async function loginWithGoogle(
  db: D1Database,
  profile: { sub: string; email: string; name?: string; picture?: string },
  opts: { allowSignup?: () => Promise<boolean> } = {},
): Promise<DirectoryUser | LoginRefusal> {
  const email = normalizeEmail(profile.email);
  const bySub = await findUserByGoogleSub(db, profile.sub);
  let user = bySub ?? (await findUserByEmail(db, email));

  if (user?.status === "disabled") return "disabled";
  if (!user) {
    if (!opts.allowSignup || !(await opts.allowSignup())) return "not_invited";
    // `inviteUser` creates the row as `invited`; the UPDATE below flips it to `active`, so a
    // self-registered account and an invited-then-signed-in one are indistinguishable
    // afterwards. Deliberate: nothing downstream should branch on how someone got here.
    user = await inviteUser(db, { email });
  }

  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE users
          SET google_sub = ?, name = COALESCE(?, name), picture = COALESCE(?, picture),
              email = ?, status = 'active', last_login_at = ?
        WHERE id = ?`,
    )
    .bind(profile.sub, profile.name ?? null, profile.picture ?? null, email, now, user.id)
    .run();
  return (await findUserById(db, user.id))!;
}

/** Narrowing helper — `loginWithGoogle` returns either the user or a reason it said no. */
export function isRefusal(r: DirectoryUser | LoginRefusal): r is LoginRefusal {
  return typeof r === "string";
}

/**
 * The pre-existing single user of this installation.
 *
 * Exists because the password gate has to keep working through P0: cutting it before Google
 * OAuth is verified live would lock the only real user out of a working app, and the owner
 * row is also the destination of the data migration in P0.7.
 */
export async function ensureOwner(db: D1Database, email: string): Promise<DirectoryUser> {
  const wanted = normalizeEmail(email);
  const existing = await db.prepare("SELECT * FROM users WHERE is_owner = 1").first<DirectoryUser>();
  if (!existing) return inviteUser(db, { email: wanted, isOwner: true });

  // Reconcile the address with the configured `OWNER_EMAIL`. Without this the owner row keeps
  // whatever placeholder it was created with (e.g. the local `owner@localhost`), and the first
  // real Google sign-in matches nothing — the owner would be told "not invited" while their
  // entire financial history sits in the Durable Object named by this very row. The owner row
  // is defined as "the human running this installation", so its email follows the config.
  if (wanted && existing.email !== wanted) {
    await db.prepare("UPDATE users SET email = ? WHERE id = ?").bind(wanted, existing.id).run();
    return (await findUserById(db, existing.id))!;
  }
  return existing;
}

/** Marks a successful sign-in. Kept separate from `loginWithGoogle` so the transitional
 *  password path reports the same "active / last seen" facts as OAuth does — otherwise the
 *  owner would sit at `status='invited'` forever and the users list would lie. */
export async function touchLogin(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE users SET status = 'active', last_login_at = ? WHERE id = ?")
    .bind(Math.floor(Date.now() / 1000), id)
    .run();
}

export async function listUsers(db: D1Database): Promise<DirectoryUser[]> {
  return (await db.prepare("SELECT * FROM users ORDER BY created_at").all<DirectoryUser>()).results;
}

/**
 * "This user made a request just now."
 *
 * Written from the request guard, so it answers the only question the owner actually has about a
 * stranger who signed up — is anyone using this? — which `last_login_at` cannot: a 30-day session
 * means someone can use the app daily for a month without logging in again.
 *
 * Throttled to once an hour per user: it is a directory WRITE on a path that runs before every
 * single API call, and minute-level precision buys nothing here.
 */
export async function touchSeen(db: D1Database, id: string, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await db
    .prepare("UPDATE users SET last_seen_at = ? WHERE id = ? AND COALESCE(last_seen_at, 0) < ?")
    .bind(now, id, now - 3600)
    .run();
}

/** Store what a user's object reported about itself (see migration 0004). Best-effort. */
export async function saveUserStats(db: D1Database, id: string, s: UserStats): Promise<void> {
  await db
    .prepare(
      `UPDATE users SET tx_count = ?, accounts_count = ?, has_mono_key = ?, has_ai_key = ?, stats_at = ?
        WHERE id = ?`,
    )
    .bind(s.tx_count, s.accounts_count, s.has_mono_key ? 1 : 0, s.has_ai_key ? 1 : 0, Math.floor(Date.now() / 1000), id)
    .run();
}

export async function setUserStatus(db: D1Database, id: string, status: UserStatus): Promise<void> {
  await db.prepare("UPDATE users SET status = ? WHERE id = ?").bind(status, id).run();
}

/**
 * Remove the identity row entirely. Only half of "delete an account" — the finance data lives in
 * that user's Durable Object and is erased separately (`UserDO.reset()`); callers must do both,
 * in that order, so a failure leaves an unreachable account rather than a reachable empty one.
 *
 * Distinct from `setUserStatus('disabled')` on purpose: disabling closes the door and keeps
 * everything, deletion is for "erase me". Both existed only as the former until 2026-07-26.
 */
export async function deleteUser(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
}

// ---- demo sandbox registry (P4.2) -------------------------------------------
// The cron sweep uses this to find and wipe sandboxes whose 24h alarm may not have fired after
// an eviction (see migrations-directory/0003). The table may not exist yet on a directory db
// that hasn't been migrated — callers wrap in try/catch so the demo path degrades to
// "alarm-only cleanup" rather than 500-ing.

export async function registerDemoSession(db: D1Database, demoId: string, expiresAt: number): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO demo_sessions (demo_id, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(demoId, Math.floor(Date.now() / 1000), expiresAt)
    .run();
}

export async function listExpiredDemoSessions(db: D1Database, now = Math.floor(Date.now() / 1000)): Promise<string[]> {
  const rows = await db
    .prepare("SELECT demo_id FROM demo_sessions WHERE expires_at <= ? LIMIT 500")
    .bind(now)
    .all<{ demo_id: string }>();
  return (rows.results ?? []).map((r) => r.demo_id);
}

export async function deleteDemoSession(db: D1Database, demoId: string): Promise<void> {
  await db.prepare("DELETE FROM demo_sessions WHERE demo_id = ?").bind(demoId).run();
}
