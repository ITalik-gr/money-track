-- §SEARCH-VEC — which operations are in the semantic index, and with what words.
--
-- The vectors themselves live in Vectorize; this table holds only «row X was indexed on date Y
-- with text hashing to Z». It exists so the nightly pass can tell «the words changed» from «the
-- row was written again», which is the difference between re-embedding a handful of operations
-- and re-embedding the ledger every night to produce identical vectors: a transaction row is
-- rewritten by every enrichment, every category change and every sync, and almost none of those
-- touch the words the index is built from.
--
-- ⚠️ Deliberately NOT a column on `transactions`. The index is disposable — drop it and rebuild
-- and no figure in the app changes — and bookkeeping for a disposable thing does not belong in
-- the table that holds the money.
CREATE TABLE tx_search_index (
  tx_id      TEXT PRIMARY KEY REFERENCES transactions(id),
  text_hash  TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
