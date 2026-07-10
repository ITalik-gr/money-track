-- Цілі-накопичення (§7): скільки й до коли хочемо зібрати. Прогрес — або вручну
-- (current_amount), або привʼязка до банки (account_id → баланс = поточний прогрес).
-- Гроші — INTEGER-копійки, як усюди. Ідемпотентно (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS savings_goals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  target_amount  INTEGER NOT NULL,             -- ціль у копійках
  current_amount INTEGER NOT NULL DEFAULT 0,   -- ручний прогрес (якщо нема account_id)
  account_id     TEXT,                          -- банка-джерело прогресу (опц.)
  deadline       INTEGER,                       -- unix, опц.
  color          TEXT,
  note           TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_goals_active ON savings_goals (is_active);
