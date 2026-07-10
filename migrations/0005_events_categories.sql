-- Події-групи (івент/проєкт/день/подорож), розширена таксономія категорій із
-- підкатегоріями та податками. Ідемпотентно (IF NOT EXISTS / INSERT OR IGNORE).

-- 1) Групи транзакцій = подія / проєкт / спеціальний день -----------------------
CREATE TABLE IF NOT EXISTS event_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'event',  -- event | project | day | trip
  color      TEXT,
  icon       TEXT,
  note       TEXT,                            -- контекст для AI ("відпустка в Карпатах")
  is_active  INTEGER DEFAULT 1,
  created_at INTEGER
);

-- транзакція належить щонайбільше одній події (nullable). Без REFERENCES у ALTER
-- (обмеження SQLite) — цілісність тримаємо на рівні застосунку.
ALTER TABLE transactions ADD COLUMN event_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_tx_event ON transactions(event_id);

-- позначка кастомних (доданих користувачем) категорій
ALTER TABLE categories ADD COLUMN is_custom INTEGER DEFAULT 0;

-- 2) Нові верхньорівневі витратні категорії --------------------------------------
INSERT OR IGNORE INTO categories (id, name, icon, color, is_income) VALUES
  (19, 'Освіта',            'book',     '#2450C8', 0),
  (20, 'Діти',              'baby',     '#D99414', 0),
  (21, 'Тварини',           'paw',      '#7A3E9D', 0),
  (22, 'Спорт і фітнес',    'dumbbell', '#127C86', 0),
  (23, 'Подарунки',         'gift',     '#B23A2E', 0),
  (24, 'Податки',           'tax',      '#6B7A74', 0);

-- 3) Податки — підкатегорії (parent 24) ------------------------------------------
INSERT OR IGNORE INTO categories (id, name, icon, color, parent_id, is_income) VALUES
  (25, 'Єдиний податок',    'tax', '#6B7A74', 24, 0),
  (26, 'ЄСВ',               'tax', '#6B7A74', 24, 0),
  (27, 'Військовий збір',   'tax', '#6B7A74', 24, 0),
  (28, 'ПДФО',              'tax', '#6B7A74', 24, 0);

-- 4) Підкатегорії до наявних витратних ------------------------------------------
INSERT OR IGNORE INTO categories (id, name, icon, color, parent_id, is_income) VALUES
  (30, 'Супермаркет',       'cart',   '#1F6E4C', 1,  0),
  (31, 'Ринок',             'cart',   '#1F6E4C', 1,  0),
  (32, 'Кава',              'coffee', '#D99414', 2,  0),
  (33, 'Ресторани',         'coffee', '#D99414', 2,  0),
  (34, 'Доставка їжі',      'coffee', '#D99414', 2,  0),
  (35, 'Таксі',             'car',    '#2450C8', 3,  0),
  (36, 'Пальне',            'fuel',   '#2450C8', 3,  0),
  (37, 'Громадський',       'car',    '#2450C8', 3,  0),
  (38, 'Кіно',              'ticket', '#127C86', 6,  0),
  (39, 'Ігри',              'chip',   '#127C86', 6,  0),
  (40, 'Аптека',            'health', '#B23A2E', 4,  0),
  (41, 'Лікар',             'health', '#B23A2E', 4,  0),
  (42, 'Стрімінги',         'repeat', '#D99414', 12, 0),
  (43, 'Софт і хмара',      'laptop', '#D99414', 12, 0);

-- 5) Нові дохідні категорії ------------------------------------------------------
INSERT OR IGNORE INTO categories (id, name, icon, color, is_income) VALUES
  (44, 'Продаж',            'tag',    '#1F6E4C', 1),
  (45, 'Кешбек',            'coins',  '#1F6E4C', 1),
  (46, 'Проценти',          'coins',  '#1F6E4C', 1),
  (47, 'Подарунок',         'gift',   '#1F6E4C', 1);
