-- A second door into ONE account: a bearer token for MCP clients (Claude Code, Claude Desktop).
--
-- WHY IT IS NOT THE SESSION COOKIE. `__Host-mt_session` is a browser credential — it cannot be
-- read by a client that is not a browser, and pasting one into a config file would hand a
-- long-lived copy of a browser session to a process on disk. This is a separate credential with
-- its own generation number, so revoking the token an editor holds does not sign anyone out of
-- their phone, and vice versa.
--
-- `mcp_version` is the same mechanism as `token_version` (0005) and for the same reason: the
-- token is stateless and HMAC-signed, so the only way to end one early is to bake a generation
-- into the signature and bump it here. Issuing a new token bumps it too — a rotation that leaves
-- the previous token working is not a rotation.
--
-- `mcp_issued_at` exists ONLY so the settings screen can say "issued on <date>" rather than
-- "a token may or may not exist". NULL means revoked or never issued; the version number alone
-- cannot answer that (it counts both issues and revocations).
ALTER TABLE users ADD COLUMN mcp_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mcp_issued_at INTEGER;
