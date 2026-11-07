-- §REFUND-FILE — a card merchant's refund is a negative spend of its charges' category, not income.
--
-- Enrichment filed shop refunds (Cloudflare card-check reversals, a Rozetka return) under the
-- seeded income category «Повернення» (17), so §REFUND never recognised them: the refunds counted
-- as income while the charges stayed full spending. Enrichment now re-files such a receipt
-- (`refundCategoryFor`); this applies the same rule to stored rows. Card rows only (an MCC other
-- than P2P 4829) — money a person sends back has no purchase to undo — and never a row whose raw
-- description has a MANUAL alias (a person's decision).
UPDATE transactions SET category_id = (
  SELECT t2.category_id FROM transactions t2 JOIN categories c2 ON c2.id = t2.category_id
  WHERE t2.id != transactions.id AND t2.amount < 0 AND t2.is_transfer = 0 AND c2.is_income = 0
    AND COALESCE(c2.parent_id, t2.category_id) != 13
    AND (t2.merchant = transactions.merchant
         OR json_extract(t2.raw_json, '$.description') = json_extract(transactions.raw_json, '$.description'))
  GROUP BY t2.category_id ORDER BY COUNT(*) DESC LIMIT 1
)
WHERE category_id = 17 AND amount > 0 AND mcc IS NOT NULL AND mcc != 4829
  AND NOT EXISTS (
    SELECT 1 FROM merchant_aliases ma WHERE ma.match_type = 'mono_desc' AND ma.source = 'manual'
      AND ma.raw_key = json_extract(transactions.raw_json, '$.description'))
  AND EXISTS (
    SELECT 1 FROM transactions t2 JOIN categories c2 ON c2.id = t2.category_id
    WHERE t2.id != transactions.id AND t2.amount < 0 AND t2.is_transfer = 0 AND c2.is_income = 0
      AND COALESCE(c2.parent_id, t2.category_id) != 13
      AND (t2.merchant = transactions.merchant
           OR json_extract(t2.raw_json, '$.description') = json_extract(transactions.raw_json, '$.description')));

-- An AI alias «<description> → Повернення» files the NEXT charge with that description under an
-- income category at ingest. Drop the ones whose description also names charges.
DELETE FROM merchant_aliases
WHERE match_type = 'mono_desc' AND source = 'ai' AND category_id = 17
  AND EXISTS (SELECT 1 FROM transactions t WHERE t.amount < 0
              AND json_extract(t.raw_json, '$.description') = merchant_aliases.raw_key);
