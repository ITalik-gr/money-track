-- §Аналітика 2.0: збережені AI-репорти (щотижня/щомісяця, на Sonnet 5). Історія
-- зберігається; старі репорти можна згодовувати AI для точнішого аналізу траєкторії.
CREATE TABLE IF NOT EXISTS ai_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  period_type TEXT NOT NULL,        -- 'week' | 'month'
  period_from INTEGER NOT NULL,     -- межі періоду (unix)
  period_to   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  model       TEXT,                 -- модель, якою згенеровано
  cost_usd    REAL,                 -- орієнтовна вартість генерації
  summary     TEXT,                 -- короткий підсумок (для списку)
  data_json   TEXT NOT NULL         -- повний структурований репорт (JSON)
);
CREATE INDEX IF NOT EXISTS idx_ai_reports_period ON ai_reports(period_type, period_to DESC);
-- Один репорт на конкретний період+тип (ідемпотентність крону/ручної генерації).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_reports_unique ON ai_reports(period_type, period_from, period_to);
