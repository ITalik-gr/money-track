-- §SUB4: підписки/платежі «кожні N періодів» (напр. раз на 3 місяці). period лишається
-- 'month'|'week', period_count — множник інтервалу. Місячний тягар = period_amount/period_count
-- (для month) — щоб квартальна підписка рахувалась як третина суми на місяць.
ALTER TABLE planned_payments ADD COLUMN period_count INTEGER NOT NULL DEFAULT 1;
