-- §AI-RECURRING (2026-08-27) — the model's guess that a charge is a recurring subscription.
--
-- WHY A COLUMN AND NOT A DERIVATION. `detectCandidates`/§SUB-DETECT answers the same question
-- from HISTORY, and answers it well — but it cannot answer it until the second month, because a
-- rhythm needs two points. The one moment a person is willing to confirm "yes, that is a new
-- subscription" is the day the first charge lands and they can still remember signing up. This
-- column is what carries that moment forward; enrich already looks at the operation, so the guess
-- costs one extra field on a call that was happening anyway (~$0.02/month).
--
-- NULL = never asked (every row before this migration, and anything enrich has not seen).
-- 0/1 = the model was asked and answered. The three states are deliberate: "not asked" and "asked
-- and said no" lead to different behaviour, and one nullable column carries both without a flag.
ALTER TABLE transactions ADD COLUMN ai_recurring INTEGER;

-- Read by the detector, which filters to recent unclaimed charges. Partial, because the answer is
-- 1 for a tiny minority of rows and an index over the rest would be paid for on every write.
CREATE INDEX IF NOT EXISTS idx_tx_ai_recurring ON transactions(ai_recurring, time) WHERE ai_recurring = 1;
