-- Per-user credentials (PLATFORM.md §4): each person brings their own monobank token and
-- their own Anthropic key, so nobody pays for anybody else's AI and nobody's bank token sits
-- in a shared place.
--
-- Stored ENCRYPTED (AES-GCM) even though this table already lives inside the user's own
-- Durable Object. Two layers, two different failure modes: the DO stops one user reading
-- another's row, the encryption stops a raw storage dump from being useful at all. The master
-- key is a Worker secret and is never written here — a copy of this table alone is inert.
--
-- The plaintext is never returned to a client. The UI shows status only ("set ✓, last
-- verified …"), which is why `last_ok_at` exists: a token that silently expired otherwise
-- looks identical to one that works.
CREATE TABLE IF NOT EXISTS user_secrets (
  name       TEXT PRIMARY KEY,     -- 'mono_token' | 'anthropic_api_key'
  ciphertext TEXT NOT NULL,        -- base64(AES-GCM ciphertext)
  iv         TEXT NOT NULL,        -- base64(12-byte nonce); unique per write
  updated_at INTEGER NOT NULL,
  last_ok_at INTEGER               -- last time the credential was verified against its API
);
