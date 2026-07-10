-- Money Track — initial schema (plan §4). Money is stored in minor units (копійки)
-- as INTEGER everywhere; divide by 100 only on display. No floats for money.

-- Рахунки (моно-картки, банки/jars, готівка, позамоно, крипта)
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,        -- mono account/jar id, або uuid для ручних
  type          TEXT,                    -- black/white/platinum/fop/jar/cash/manual_card/crypto
  title         TEXT,
  currency_code INTEGER,                 -- ISO 4217: 980 UAH, 840 USD, 978 EUR
  balance       INTEGER,                 -- у мінімальних одиницях валюти рахунку
  credit_limit  INTEGER,                 -- копійки; на чорній великий, НЕ рахувати як мої гроші
  is_manual     INTEGER DEFAULT 0,       -- 1 = веду вручну (позамоно картка/крипта)
  iban          TEXT,
  is_active     INTEGER DEFAULT 1,
  updated_at    INTEGER
);

-- Категорії
CREATE TABLE categories (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  icon      TEXT,
  color     TEXT,
  parent_id INTEGER REFERENCES categories(id),
  is_income INTEGER DEFAULT 0
);

-- Правила авто-категоризації (mcc / мерчант / текст)
CREATE TABLE rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_type  TEXT NOT NULL,             -- 'mcc' | 'merchant' | 'text'
  pattern     TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  priority    INTEGER DEFAULT 0
);

-- Навчені відповідники мерчантів (пояснив раз -> запам'ятав)
CREATE TABLE merchant_aliases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  match_type   TEXT NOT NULL,            -- 'mono_desc' | 'mcc' | 'text'
  raw_key      TEXT NOT NULL,            -- сирий опис від моно / код mcc / підрядок
  display_name TEXT,                     -- людська назва ("кав'ярня біля дому")
  category_id  INTEGER REFERENCES categories(id),
  created_at   INTEGER
);

-- Заплановані/регулярні платежі (підписки, розстрочки)
CREATE TABLE planned_payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL,           -- 'subscription' | 'installment'
  total_amount  INTEGER,                 -- копійки; для розстрочки повна сума
  period_amount INTEGER,                 -- копійки за період (рахуємо якщо не задано)
  period        TEXT NOT NULL,           -- 'month' | 'week'
  start_date    INTEGER NOT NULL,
  end_date      INTEGER,                 -- рахуємо для розстрочки; NULL = безстроково
  occurrences   INTEGER,                 -- скільки платежів лишилось (розстрочка)
  category_id   INTEGER REFERENCES categories(id),
  account_id    TEXT REFERENCES accounts(id),
  is_active     INTEGER DEFAULT 1
);

-- Чеки
CREATE TABLE receipts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT,                   -- FK to transactions(id) (circular, not enforced)
  image_key      TEXT,                   -- ключ у R2
  store          TEXT,
  purchased_at   INTEGER,
  total          INTEGER,                -- копійки
  currency_code  INTEGER,
  ai_json        TEXT,
  created_at     INTEGER
);

-- Транзакції (моно + готівка + ручні)
CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,        -- mono statementItem id, або uuid
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  source        TEXT NOT NULL,           -- 'mono' | 'cash' | 'manual'
  time          INTEGER NOT NULL,        -- unix
  amount        INTEGER NOT NULL,        -- копійки, від'ємне = витрата
  currency_code INTEGER NOT NULL,
  mcc           INTEGER,
  category_id   INTEGER REFERENCES categories(id),
  merchant      TEXT,                    -- опис від моно або введений
  comment       TEXT,                    -- коментар від моно
  user_note     TEXT,                    -- моя анотація/контекст для АІ
  balance_after INTEGER,
  cashback      INTEGER,
  hold          INTEGER DEFAULT 0,
  planned_id    INTEGER REFERENCES planned_payments(id),
  receipt_id    INTEGER REFERENCES receipts(id),
  raw_json      TEXT,
  created_at    INTEGER
);
CREATE INDEX idx_tx_time     ON transactions(time);
CREATE INDEX idx_tx_category ON transactions(category_id);
CREATE INDEX idx_tx_account  ON transactions(account_id);

-- Позиції чека
CREATE TABLE receipt_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id  INTEGER NOT NULL REFERENCES receipts(id),
  name        TEXT,
  qty         REAL,
  price       INTEGER,                   -- копійки
  category_id INTEGER REFERENCES categories(id)
);

-- Бюджети по категоріях
CREATE TABLE budgets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id   INTEGER REFERENCES categories(id),
  period        TEXT NOT NULL,           -- 'month' | 'week'
  amount        INTEGER NOT NULL,        -- копійки
  currency_code INTEGER DEFAULT 980
);

-- Стан синхронізації, статус вебхука, курсор бекфілу, кеш курсів валют
CREATE TABLE app_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
