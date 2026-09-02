-- §GOAL-CUR — a goal's money has a currency of its own.
--
-- Until now it had none: `target_amount` was a typed figure and therefore stored in hryvnia
-- (§BASE-CUR, which holds precisely because these tables have no currency column), while a
-- jar-linked goal's progress is the ACCOUNT balance, in the jar's currency. Both were then
-- converted into the display base and compared. The result on the owner's real data: a monobank
-- jar funded in dollars read «4 480 ₴ з 2 000 ₴ · 100% · Ціль досягнута» for a goal that is
-- about 5% complete, because the $2 000 he typed had been stored as 2 000 ₴.
--
-- NULL keeps the historical meaning (hryvnia), so every existing manual goal is untouched.
ALTER TABLE savings_goals ADD COLUMN currency_code INTEGER;

-- A jar-backed goal is denominated in its jar's currency — that is the currency the money
-- physically is, and it is what the target was typed against. The stored NUMBER is deliberately
-- left alone: re-labelling 2 000 as $2 000 is what the owner meant when he typed it. For a
-- hryvnia jar this changes nothing at all (980 is what the column already implied).
UPDATE savings_goals
   SET currency_code = (SELECT a.currency_code FROM accounts a WHERE a.id = savings_goals.account_id)
 WHERE account_id IS NOT NULL;
