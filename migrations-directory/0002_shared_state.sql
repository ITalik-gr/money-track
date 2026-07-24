-- Shared, user-independent cache. Exactly one writer (the Worker's cron), many readers
-- (every user's Durable Object).
--
-- Exists for one reason: currency rates. They are a fact about the world, not about a person,
-- and monobank rate-limits the endpoint hard. Fetching them per user would hammer the bank
-- N times for one identical answer and start failing as soon as there are a handful of users.
-- So the cron fetches once, writes here, and each DO copies the value into its own
-- `app_state.rates` — which keeps `getRates()` and the canonical ₴ conversion untouched.
CREATE TABLE IF NOT EXISTS shared_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
