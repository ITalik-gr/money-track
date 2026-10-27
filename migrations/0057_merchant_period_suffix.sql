-- §MERCH-PERIOD — one recurring bank charge is one merchant, whatever month it names.
--
-- Monobank writes its interest as «Списання відсотків за вересень»; grouping by merchant made each
-- month a new merchant, so the Advisor called last month's «stopped» and gave this month's a
-- 90-day-÷-3 figure. Ingest now strips the trailing «за <month>» (`merchantFromDescription`);
-- this applies the same cut to stored rows. Only rows nobody renamed (`name_locked = 0`); the
-- bank's text stays in `raw_json`. Suffix-exact per month, not INSTR(' за '), so «Оплата за
-- квартиру за жовтень» loses only its last two words.
UPDATE transactions SET merchant = SUBSTR(merchant, 1, LENGTH(merchant) - 10) WHERE name_locked = 0 AND merchant LIKE '% за січень' AND LENGTH(merchant) > 10;
UPDATE transactions SET merchant = SUBSTR(merchant, 1, LENGTH(merchant) - 9) WHERE name_locked = 0 AND merchant LIKE '% за лютий' AND LENGTH(merchant) > 9;
UPDATE transactions SET merchant = SUBSTR(merchant, 1, LENGTH(merchant) - 12) WHERE name_locked = 0 AND merchant LIKE '% за березень' AND LENGTH(merchant) > 12;
UPDATE transactions SET merchant = SUBSTR(merchant, 1, LENGTH(merchant) - 11) WHERE name_locked = 0 AND merchant LIKE '% за квітень' AND LENGTH(merchant) > 11;
UPDATE transactions SET merchant = SUBSTR(merchant, 1, LENGTH(merchant) - 11) WHERE name_locked = 0 AND merchant LIKE '% за травень' AND LENGTH(merchant) > 11;
UPDATE transactions SET merchant = SUBSTR(merchant, 1, LENGTH(merchant) - 11) WHERE name_locked = 0 AND merchant LIKE '% за червень' AND LENGTH(merchant) > 11;
UPDATE transactions SET merchant = SUBSTR(merchant, 1, LENGTH(merchant) - 10) WHERE name_locked = 0 AND merchant LIKE '% за липень' AND LENGTH(merchant) > 10;
UPDATE transactions SET merchant = SUBSTR(merchant, 1, LENGTH(merchant) - 11) WHERE name_locked = 0 AND merchant LIKE '% за серпень' AND LENGTH(merchant) > 11;
UPDATE transactions SET merchant = SUBSTR(merchant, 1, LENGTH(merchant) - 12) WHERE name_locked = 0 AND merchant LIKE '% за вересень' AND LENGTH(merchant) > 12;
UPDATE transactions SET merchant = SUBSTR(merchant, 1, LENGTH(merchant) - 11) WHERE name_locked = 0 AND merchant LIKE '% за жовтень' AND LENGTH(merchant) > 11;
UPDATE transactions SET merchant = SUBSTR(merchant, 1, LENGTH(merchant) - 12) WHERE name_locked = 0 AND merchant LIKE '% за листопад' AND LENGTH(merchant) > 12;
UPDATE transactions SET merchant = SUBSTR(merchant, 1, LENGTH(merchant) - 11) WHERE name_locked = 0 AND merchant LIKE '% за грудень' AND LENGTH(merchant) > 11;
