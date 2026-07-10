-- §R2-CUR1: виправлення перемішаних валют у mono-транзакціях.
-- Баг: monobank `amount` — сума у валюті РАХУНКУ, але зберігалося разом з `currencyCode`
-- (валюта ОПЕРАЦІЇ). Для UAH-картки, що платить у $, виходило «$800» замість «₴800».
--
-- Fix сховища:
--   1) Нові поля original_amount / original_currency — реальна валюта операції
--      (operationAmount / currencyCode) для нових транзакцій, показ «$20 → 800 ₴».
--   2) Перерахунок currency_code наявних mono-транзакцій із валюти їхнього рахунку
--      (бо amount завжди у валюті рахунку). Старим original не відновлюємо.

ALTER TABLE transactions ADD COLUMN original_amount   INTEGER;
ALTER TABLE transactions ADD COLUMN original_currency INTEGER;

-- Перерахунок: currency_code = валюта рахунку для всіх mono-транзакцій.
UPDATE transactions
SET currency_code = (
  SELECT a.currency_code FROM accounts a WHERE a.id = transactions.account_id
)
WHERE source = 'mono'
  AND EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = transactions.account_id AND a.currency_code IS NOT NULL
  );
