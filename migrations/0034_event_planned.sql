-- Event/trip planned line items (P2.3, PLATFORM.md §8): turns a group into a mini-budget with a
-- PLAN (what you expect to spend, itemized) to compare against ACTUAL (tagged transactions).
--
-- Plan amounts are stored in ₴ minor units, unlike transactions (which are in the account
-- currency): a plan is an up-front estimate — "≈ ₴8,000 on flights" — not a real charge, so there
-- is no source currency to preserve, and keeping it in ₴ lets the plan-vs-actual comparison use
-- the same canonical ₴ roll-up the event summary already does. category_id is optional (a plan
-- line can be as loose as "Food" or as specific as a category).
CREATE TABLE IF NOT EXISTS event_planned (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL,
  label       TEXT    NOT NULL,
  amount      INTEGER NOT NULL,        -- planned amount, ₴ minor units (kopiykas)
  category_id INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_planned_event ON event_planned(event_id);
