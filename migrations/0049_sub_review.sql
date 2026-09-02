-- §SUB-REVIEW (2026-09-02) — the model's verdict on ONE merchant: is this a bill, or a shop.
--
-- WHY A TABLE AND NOT A LIVE CALL. `/planned/detect` is a GET the Subscriptions page issues on
-- every open. A model call inside it would be paid for on every page view and would make the list
-- arrive seconds late, and the answer it produces («Сільпо is a grocery shop») does not change
-- between two page loads. So the verdict is DECIDED once, in the daily pass, and READ here.
--
-- WHY KEYED ON THE MERCHANT ALONE. The key is `coreToken` (`lib/finance/merchants.ts`), this
-- project's one answer to "is this the same merchant, roughly" — the same key §SUB-DETECT groups
-- by, so a verdict cannot end up describing a different grouping than the one on screen. Price and
-- currency are deliberately NOT in the key: a subscription that raised its price, or that the card
-- settles in a different currency this month, is the same merchant and the same answer. Storing
-- them in the key would silently re-ask (and re-pay) every time a foreign biller's rate moved —
-- which is precisely the population §SUB-DETECT exists to catch.
--
-- `amount`/`currency_code` are kept as CONTEXT: what the model was actually shown when it decided.
-- Without them a wrong verdict cannot be explained afterwards, only overruled.
CREATE TABLE IF NOT EXISTS sub_review (
  merchant_key  TEXT PRIMARY KEY,     -- coreToken(merchant), lower-cased
  merchant      TEXT NOT NULL,        -- the spelling shown to the model, for the audit trail
  verdict       TEXT NOT NULL,        -- 'subscription' | 'not' | 'unsure'
  reason        TEXT,                 -- one short line, in the reader's language (§LANG)
  amount        INTEGER,              -- minor units, what the model was shown
  currency_code INTEGER,
  decided_at    INTEGER NOT NULL
);

-- The daily pass asks "what has no fresh verdict", which is a scan over a table with one row per
-- merchant the detector has ever proposed — tens of rows, not thousands. The index exists for the
-- `unsure` re-ask window, which is the only query that filters rather than reads the lot.
CREATE INDEX IF NOT EXISTS idx_sub_review_stale ON sub_review(verdict, decided_at);
