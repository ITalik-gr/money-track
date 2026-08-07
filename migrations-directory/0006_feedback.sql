-- Feedback from whoever is using the app — the one channel back to the developer.
--
-- Until now there was none: a stranger who hit a bug had nowhere to say so, and the app had no
-- way of learning it was broken for anyone but its author. Since registration opened (2026-07-31)
-- that stopped being a theoretical gap.
--
-- It lives in the DIRECTORY database, not in the sender's Durable Object, for two reasons that
-- both matter: the owner has to be able to READ it (they never open another user's object), and a
-- demo visitor's object is deleted 24 hours later — which is precisely the visitor most likely to
-- report that something looked wrong on a first run.
--
-- ⚠️ Nothing financial is stored here, and that is a rule rather than an accident: this is the one
-- table in the system the owner reads across users, so it may only ever hold what the sender
-- deliberately typed plus the context needed to act on it.
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL for a demo visitor: they have no account, and inventing an id for them would be a
  -- pseudonymous identifier for someone who never signed up for one.
  user_id    TEXT,
  -- Copied from the directory at submit time rather than joined at read time: the account may be
  -- deleted later, and a report the owner cannot answer is half a report. A demo visitor may type
  -- their own address here, or leave it empty and stay anonymous.
  email      TEXT,
  kind       TEXT NOT NULL,          -- 'bug' | 'idea' | 'other'
  message    TEXT NOT NULL,
  -- Which screen it was sent from, and what browser. Both come from the client and are therefore
  -- untrusted — they are a hint for reproducing, never a fact to act on.
  page       TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  -- When the owner marked it dealt with. NULL = still in the inbox.
  handled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);
