-- §MEMORY: what the assistant knows about this person across every conversation and AI feature.
--
-- Separate from `facts` on purpose. A fact is a statement that can move a NUMBER behind a
-- confirmation gate (§A1). A memory is background that shapes an answer and never moves a number,
-- so it can be written automatically without that gate.
CREATE TABLE IF NOT EXISTS agent_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,                 -- stable slug («job», «rent»): one current truth per topic
  text TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- identity | work | housing | obligation | goal | plan | preference | context
  horizon TEXT NOT NULL,               -- lasting | months | weeks | days
  importance INTEGER NOT NULL DEFAULT 2, -- 1 detail · 2 useful · 3 changes advice
  status TEXT NOT NULL DEFAULT 'active', -- active | archived
  archive_reason TEXT,                 -- expired | stale | replaced | resolved | user | cap
  pinned INTEGER NOT NULL DEFAULT 0,   -- the user's own «keep this»; nothing automatic touches it
  source TEXT NOT NULL DEFAULT 'chat', -- chat | user
  valid_until INTEGER,                 -- a known end; past it the memory is simply over
  review_at INTEGER NOT NULL,          -- from here it is shown as «may be out of date»
  confirmed_at INTEGER NOT NULL,       -- last time the user said or implied it still holds
  replaced_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The database, not the model, guarantees one current truth per topic.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_topic ON agent_memory(topic) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_agent_memory_status ON agent_memory(status, updated_at);
