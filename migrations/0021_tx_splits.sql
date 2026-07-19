-- Спліт транзакції: одна покупка (напр. супермаркет) розкладається на кілька категорій.
-- Частина = рядок tx_splits; amount у КОПІЙКАХ, той самий знак, що transactions.amount
-- (від'ємний для витрати). Сума частин мусить дорівнювати transactions.amount (валідуємо в API).
--
-- Інтеграція в канон (stats.ts): STATS_JOINS робить LEFT JOIN tx_splits → рядок спліт-tx
-- розмножується на частини, EFF_CAT/EFF_AMOUNT беруть категорію й суму частини. Тож спліт
-- потрапляє в УСЮ категорійну аналітику узгоджено (byCategory/patterns/levels/importance/spark),
-- без переписування кожного запиту. Баланс — з accounts.balance (моно), спліт його НЕ чіпає.
-- Спліт лише для витрат (дохід не ділимо — INCOME_WHERE лишається на t.amount).
CREATE TABLE tx_splits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id       TEXT NOT NULL REFERENCES transactions(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  amount      INTEGER NOT NULL,        -- копійки, знак як у transactions.amount (витрата < 0)
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_tx_splits_tx ON tx_splits(tx_id);
