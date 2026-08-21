-- How many people opened the demo, per day.
--
-- The data existed and kept being thrown away. `demo_sessions` knows every sandbox, but the daily
-- sweep deletes each row 24 hours after it was created — so "how many yesterday" was already
-- unanswerable by the time anyone asked. The quota counter in `shared_state` (`demo_new_<day>`)
-- survives, but it counts ATTEMPTS at the gate, including the ones it then refuses: the same
-- distinction that made `allowSignup` count only real creations.
--
-- So: one row per day, written where the sandbox is actually created and seeded. One row a day is
-- nothing to store and the only form in which this question stays answerable a month later.
--
-- ⚠️ A visit is a NEW sandbox, not a page view. Someone returning within 24 hours reuses their
-- cookie and is not counted again — which makes this "people who started a demo", the number
-- worth knowing, rather than a hit counter.
CREATE TABLE IF NOT EXISTS demo_daily (
  -- 'YYYY-MM-DD' in Europe/Kyiv, because a human who lives in that timezone reads it: a chart
  -- whose day rolls over at 03:00 local reads as wrong data, not as a different definition of
  -- "day". ⚠️ This note used to say "deliberately NOT the UTC day the quota keys use" — on
  -- 2026-08-21 those keys became Kyiv too, precisely because the disagreement was the defect
  -- rather than a design.
  day        TEXT PRIMARY KEY,
  sandboxes  INTEGER NOT NULL DEFAULT 0
);
