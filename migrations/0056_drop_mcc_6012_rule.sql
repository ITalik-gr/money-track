-- MCC 6012 is "financial institution — merchandise and services": mono books its OWN interest
-- («Списання відсотків за вересень») and penalty fees («За перевищення кредитного ліміту») under
-- it. The seed (0002) filed it with ATM/cash MCCs as «Перекази і зняття», so real spending landed
-- in a transfer bucket and the owner saw "a transfer" for money that went nowhere.
--
-- Dropped rather than re-pointed: there is no category that is right for every user. Without a
-- rule the row reaches enrichment / §AI-CATCHUP, which pick from the person's OWN categories.
-- Only the untouched seed rule goes (priority 10, bucket 13); a rule the user wrote differently
-- stays. Rows already filed are not rewritten (§AI-AUDIT: nothing decided is argued with).
DELETE FROM rules WHERE match_type = 'mcc' AND pattern = '6012' AND category_id = 13 AND priority = 10;
