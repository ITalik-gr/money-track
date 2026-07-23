-- Умови кредитної картки. Для рахунків із credit_limit>0. Живлять нагадування про платіж
-- (подія `deadline` у Центрі сповіщень) і показ строків на картці рахунку.
--
--   statement_day — число місяця, коли формується виписка (1..31);
--   payment_day   — число місяця, до якого треба внести платіж (1..31);
--   min_payment   — мінімальний платіж, копійки у валюті рахунку (NULL = не задано).
-- Усі NULL за замовчуванням: звичайна дебетова картка їх не має.
ALTER TABLE accounts ADD COLUMN statement_day INTEGER;
ALTER TABLE accounts ADD COLUMN payment_day INTEGER;
ALTER TABLE accounts ADD COLUMN min_payment INTEGER;
