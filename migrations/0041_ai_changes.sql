-- §AI-AUDIT — a record of what the model CHANGED, and the value it changed away from.
--
-- The app lets AI rewrite a transaction's category, its transfer flag and its understanding
-- (`ai_note`) — from enrichment, from the re-sweep, and from the chat on the detail page. Until
-- now none of that left a trace: a category could differ from what the bank or the person had put
-- there, and nothing said who decided that or what it used to be. "Why is this in Entertainment"
-- had no answer, and there was no way back short of remembering the old value.
--
-- Storing the OLD value and not just the new one is the whole point: without it this is a log,
-- with it it is an undo.
CREATE TABLE IF NOT EXISTS ai_changes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id        TEXT NOT NULL,
  -- 'category_id' | 'is_transfer' | 'ai_note' — the column the model wrote.
  field        TEXT NOT NULL,
  old_value    TEXT,                 -- NULL is a real previous value (no category yet), not "unknown"
  new_value    TEXT,
  -- Which path did it: 'enrich' (automatic), 'chat' (asked for on the detail page), 'resweep'.
  source       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  -- Set when the user put the old value back. The row STAYS: "the AI did this and I undid it" is
  -- more informative than silence, and it is what stops the same correction being offered twice.
  reverted_at  INTEGER,
  FOREIGN KEY (tx_id) REFERENCES transactions(id) ON DELETE CASCADE
);

-- The detail page asks "what happened to THIS operation"; the settings list asks "what happened
-- lately". Both are covered by one composite plus the time index.
CREATE INDEX IF NOT EXISTS idx_ai_changes_tx ON ai_changes (tx_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_changes_time ON ai_changes (created_at DESC);
