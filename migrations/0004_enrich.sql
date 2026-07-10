-- Мульти-категорії (основна category_id + теги), AI-збагачення, навчання переказів.
CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  category_id    INTEGER NOT NULL REFERENCES categories(id),
  PRIMARY KEY (transaction_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_txtags_cat ON transaction_tags(category_id);

-- Прапорець, що транзакцію вже пройшов AI (щоб не ганяти повторно).
ALTER TABLE transactions ADD COLUMN ai_enriched INTEGER NOT NULL DEFAULT 0;

-- Навчені відповідники тепер можуть нести і прапорець переказу
-- (пояснив раз, що це card-to-card / округлення → повтори авто-позначаються).
ALTER TABLE merchant_aliases ADD COLUMN is_transfer INTEGER NOT NULL DEFAULT 0;
