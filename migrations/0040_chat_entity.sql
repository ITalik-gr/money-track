-- §TX-CHAT — a conversation can now be ABOUT something.
--
-- The per-transaction chat on the detail page lived in React `useState`: it existed until the
-- user navigated away, and then it was gone. That is strictly worse than the state §CHAT-SYNC
-- (migration 0038) was created to fix — advisor conversations at least survived a reload, on one
-- device. A person explains "this was for the course, not entertainment", the model uses it, and
-- an hour later there is no record that the explanation was ever given.
--
-- Reusing `chats`/`chat_messages` rather than a new table: it is the same object (an ordered
-- exchange with the model), and it already carries the write-time limits, the cascade delete and
-- the export. What it lacked was a way to say what a conversation is about.
--
-- `kind` defaults to 'advisor' so every existing row keeps its meaning without a backfill, and the
-- advisor's rail filters on it — otherwise a chat about one coffee would appear in the list of
-- financial conversations, which is exactly the sort of "technically stored" that makes a feature
-- feel broken.
ALTER TABLE chats ADD COLUMN kind TEXT NOT NULL DEFAULT 'advisor';   -- 'advisor' | 'tx'
ALTER TABLE chats ADD COLUMN entity_id TEXT;                          -- transactions.id for kind='tx'

-- The transaction page looks a conversation up by what it is about, not by its id.
CREATE INDEX IF NOT EXISTS idx_chats_entity ON chats (kind, entity_id);
