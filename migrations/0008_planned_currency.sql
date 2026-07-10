-- Мультивалютні підписки/розстрочки (§F4): валюта планового платежу. Суми лишаються
-- INTEGER-копійки у своїй валюті; зведення в ₴ — за app_state.rates (як усюди).
ALTER TABLE planned_payments ADD COLUMN currency_code INTEGER NOT NULL DEFAULT 980;
