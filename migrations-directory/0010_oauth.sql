-- §MCP-OAUTH — this deployment becomes an OAuth 2.1 authorization server for its own MCP endpoint.
--
-- WHY, when a signed bearer token already works: Claude's built-in "add a custom connector" UI
-- accepts a URL and nothing else. It has no field for a bearer token or a custom header (an open
-- gap as of mid-2026), so the manual token can only be used by Claude Code and by a hand-edited
-- desktop config. OAuth is what makes the connector reachable from Claude Desktop, claude.ai and
-- the phone, where a config file cannot be edited at all.
--
-- WHY THE TABLES, when everything else in this app signs its credentials statelessly:
--   • `oauth_clients` — a client registers itself (RFC 7591). Its redirect URIs must be recorded
--     BEFORE the flow starts, because "validate the redirect against a pre-registered value" is
--     the whole defence against an open redirect, and there is nothing to validate against if the
--     registration is not stored.
--   • `oauth_codes` — an authorization code must be single-use. That is a fact about the past
--     ("this one was already redeemed"), and no signature can carry it.
--   • `oauth_grants` — refresh tokens must ROTATE for public clients, which means the previous
--     one has to stop working the moment the next is issued. Same reason: revocation is state.
-- Access tokens stay stateless and short-lived (signed, ~1h), so the hot path — every MCP call —
-- still costs no database read.
--
-- ⚠️ Claude registers a NEW client on each fresh connection, so this table grows with reconnects
-- rather than with users. `pruneOauthClients` is what keeps that from being unbounded.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  -- JSON array. Exact-match list; loopback entries match port-agnostically (RFC 8252 §7.3),
  -- which Claude Code REQUIRES — it binds an ephemeral port per session.
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  -- PKCE S256 only. Stored, not verified at issue time: the verifier arrives at the token call.
  code_challenge TEXT NOT NULL,
  -- RFC 8707 audience. Carried through the whole flow so the token can be bound to the ONE
  -- resource it was consented for, instead of being usable anywhere that trusts our signature.
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_exp ON oauth_codes(expires_at);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  -- SHA-256 of the refresh token. The token itself is never stored: a directory dump must not be
  -- a set of working keys to everybody's ledger.
  refresh_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id);
