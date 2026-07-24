-- Bank abstraction (PLATFORM.md §5): an account now says WHERE it comes from, and a
-- connection says WHICH credential feeds it.
--
-- Until now "where it comes from" was inferred from `is_manual` plus the shape of the id, which
-- worked only because there was exactly one bank. With a second provider that inference breaks
-- silently — a Privat account would look like a mono one and get synced with the wrong token.
--
-- `provider` is backfilled from `is_manual` rather than defaulted blindly: existing manual and
-- cash accounts are NOT monobank accounts, and marking them so would make the account sync try
-- to overwrite hand-entered balances from an API that has never heard of them.

ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'mono';
ALTER TABLE accounts ADD COLUMN connection_id TEXT;

UPDATE accounts SET provider = 'manual' WHERE is_manual = 1;

-- One row per linked credential. The secret itself never lands here — it lives encrypted in
-- `user_secrets` (PLATFORM.md §4); this table only records that a link exists and how it is doing.
CREATE TABLE IF NOT EXISTS bank_connections (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,          -- 'mono' | 'privat' | 'csv' | 'manual'
  label        TEXT,
  status       TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'error' | 'disabled'
  last_sync_at INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider);
