-- Directory: identity + invites. The ONLY storage shared between users (PLATFORM.md §2).
--
-- What is deliberately NOT here: anything financial. Accounts, transactions, budgets and
-- every derived number live inside the user's own Durable Object, so isolation is physical
-- rather than a `WHERE user_id` that some query can forget. If a column that smells like
-- money ever shows up in this file, the design has drifted.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,        -- also the Durable Object name; never reused
  email         TEXT NOT NULL UNIQUE,    -- lower-cased on write; the whitelist key
  google_sub    TEXT UNIQUE,             -- Google's stable subject id; NULL until first login
  name          TEXT,
  picture       TEXT,
  -- 'invited'  — whitelisted, has never signed in
  -- 'active'   — signed in at least once
  -- 'disabled' — refused at the door; the DO is kept, not deleted
  status        TEXT NOT NULL DEFAULT 'invited',
  is_owner      INTEGER NOT NULL DEFAULT 0,  -- the single pre-existing user (P0.7 migration target)
  invited_by    TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- Email is matched case-insensitively at the application layer (values are stored lowered),
-- because SQLite's NOCASE collation only folds ASCII — the same limitation that already bit
-- Cyrillic search in this project.
CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,           -- random, shared out-of-band
  email      TEXT,                       -- NULL = any email may redeem it
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                    -- NULL = no expiry
  used_at    INTEGER,
  used_by    TEXT                        -- users.id that redeemed it
);

CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);
