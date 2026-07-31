-- Owner-facing activity counters, so "who signed up and are they actually using it?" has an
-- answer. Registration opened on 2026-07-31; before that the owner knew every user personally.
--
-- Why counters here rather than asking each Durable Object on demand: the finance data is
-- physically isolated per user, so a live answer means waking EVERY object on every page load —
-- slow, and it grows worse exactly as the thing being measured (user count) grows. Instead each
-- object reports a handful of numbers about itself, once a day from the cron it already runs,
-- plus on sign-in.
--
-- ⚠️ Nothing here is money. `tx_count` and `accounts_count` are volume, not value; there is
-- deliberately no balance, no spend, no category. The rule from 0001 still holds: if a column
-- that smells like an amount appears in this file, the design has drifted. The owner is an
-- administrator of accounts, not a reader of other people's finances.
ALTER TABLE users ADD COLUMN last_seen_at    INTEGER;  -- last authenticated API request
ALTER TABLE users ADD COLUMN tx_count        INTEGER;  -- NULL = never reported
ALTER TABLE users ADD COLUMN accounts_count  INTEGER;
ALTER TABLE users ADD COLUMN has_mono_key    INTEGER;  -- 0/1, NULL = never reported
ALTER TABLE users ADD COLUMN has_ai_key      INTEGER;
ALTER TABLE users ADD COLUMN stats_at        INTEGER;  -- when the counters above were written
