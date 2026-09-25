-- §HEALTH-TREND — store the four parts' POINTS next to the score, per day.
--
-- The trend chart could say that the index moved and never WHY: only `score` was kept, so «68»
-- on a past day was a number with nothing behind it, and the owner asked to hover a day and see
-- what the score was made of. The points (not the 0..1 part scores) are stored because they are
-- what the card shows and what adds up to the score; a difference between two days is then read
-- directly as «stability −6, savings +2».
--
-- Nullable on purpose: rows written before this migration have no parts, and a part the data could
-- not measure (§HEALTH, e.g. stability from one month) is null rather than a fake zero.
ALTER TABLE health_history ADD COLUMN pts_runway INTEGER;
ALTER TABLE health_history ADD COLUMN pts_savings INTEGER;
ALTER TABLE health_history ADD COLUMN pts_debt INTEGER;
ALTER TABLE health_history ADD COLUMN pts_stability INTEGER;
