-- Demo sandbox registry (P4.2, PLATFORM.md §11).
--
-- Each visitor to /demo gets an ephemeral Durable Object named `demo:<random>` that seeds itself
-- and self-destructs on a 24h alarm. But an alarm is not a guarantee: a DO can be evicted and the
-- alarm may not re-fire, leaving an orphaned sandbox holding data forever. This table is the
-- backstop — the daily cron sweeps rows whose `expires_at` has passed and wipes the matching DO.
-- It lives in the DIRECTORY db (the one shared, non-user store) for the same reason the user
-- registry does: the sweep must enumerate sandboxes without knowing their names in advance.
--
-- Nothing financial here — just an id and two timestamps.
CREATE TABLE IF NOT EXISTS demo_sessions (
  demo_id    TEXT PRIMARY KEY,   -- the random half of the DO name `demo:<demo_id>`
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL    -- unix; sweep wipes the DO once now >= this
);
CREATE INDEX IF NOT EXISTS idx_demo_sessions_exp ON demo_sessions(expires_at);
