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

/**
 * Binds a Google identity to a whitelisted row and marks the session.
 *
 * Returns `null` when the email is not whitelisted or the account is disabled — the caller
 * turns that into a refusal at the door. Invite-only is enforced HERE and nowhere else, so
 * there is a single place to audit (PLATFORM.md §0.2: the demo must be its own circuit
 * rather than an exception threaded through every check).
 */
export async function loginWithGoogle(
  db: D1Database,
  profile: { sub: string; email: string; name?: string; picture?: string },
): Promise<DirectoryUser | null> {
  const email = normalizeEmail(profile.email);
  const bySub = await findUserByGoogleSub(db, profile.sub);
  const user = bySub ?? (await findUserByEmail(db, email));
  if (!user || user.status === "disabled") return null;

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

export async function setUserStatus(db: D1Database, id: string, status: UserStatus): Promise<void> {
  await db.prepare("UPDATE users SET status = ? WHERE id = ?").bind(status, id).run();
}
