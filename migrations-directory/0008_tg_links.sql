-- Which Telegram chat belongs to which user — the index that makes the bot multi-user.
--
-- Outbound pushes have been personal since §D1 (2026-08-01): each object knows its own
-- `app_state.tg_chat_id` and pushes there. Inbound COMMANDS could not follow, because they arrive
-- at the Worker from an arbitrary chat and the Worker has to decide WHICH object to wake before
-- any per-user state is reachable. `idFromName` is one-way and `app_state` lives inside the object
-- being addressed, so the answer cannot come from there. It has to be here, in the shared
-- directory — the only table both sides can read.
--
-- Consequence, and the reason this is a security-shaped change rather than a convenience one:
-- until now every unclaimed update fell through to the OWNER's object. That was safe only because
-- the bot then refused to answer anyone but the owner. With routing, the refusal moves here: a
-- chat with no row is not routed at all.
--
-- ⚠️ `chat_id` is TEXT. Telegram chat ids are 64-bit and NEGATIVE for groups; storing them as text
-- matches `app_state.tg_chat_id` (also text) and removes any chance of the two sides comparing a
-- number against a string and quietly finding nothing.
--
-- ⚠️ ONE chat maps to ONE user (PRIMARY KEY), and one user may hold several chats — phone and
-- desktop are different chats with the same bot only if the user starts it twice, but a person
-- linking a group chat as well is ordinary. The reverse direction is deliberately NOT unique.
CREATE TABLE IF NOT EXISTS tg_links (
  chat_id   TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL,
  linked_at INTEGER NOT NULL
);

-- Unlinking from the app side removes every chat a user owns, so the lookup by user has an index.
CREATE INDEX IF NOT EXISTS idx_tg_links_user ON tg_links(user_id);
