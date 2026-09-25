-- §JEV-SHARED — the owner's TypeSafe key, lent to users who have not added their own (2026-09-25).
--
-- WHY A TABLE IN THE DIRECTORY and not the users' own `ai_usage`: the question is the OWNER's —
-- «how much of MY key do other people eat» — and it has to be answered across every account
-- without waking each Durable Object. One row per user per Kyiv day, upserted on every judgment
-- that went out on the shared key; a user's own key never writes here.
--
-- Volume only: counts and input tokens, never the text that was judged.
CREATE TABLE IF NOT EXISTS jev_usage (
  user_id      TEXT NOT NULL,
  day          TEXT NOT NULL,          -- 'YYYY-MM-DD', Europe/Kyiv
  calls        INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
