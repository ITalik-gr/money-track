-- A fourth door into ONE account: a write-only bearer token for phone shortcuts (§QUICK-ADD).
--
-- WHY NOT THE MCP TOKEN. That one READS the whole ledger. A shortcut sitting in the Shortcuts app
-- of a phone, or shared by accident with a screenshot of the automation, needs to add an
-- operation and nothing else. A narrower credential makes a leak cost "someone can add rows",
-- not "someone can read my finances".
--
-- Its own generation for the same reason as `mcp_version` (0009): the token is stateless and
-- signed, so ending one early means bumping a number baked into its signature. Separate, so that
-- rotating the phone's token does not disconnect Claude, and vice versa. «Sign out everywhere»
-- revokes all of them.
ALTER TABLE users ADD COLUMN quickadd_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN quickadd_issued_at INTEGER;
