-- §A1 (AI 4.0): шар фактів про світ. Два рівні на один запис:
--   рівень 1 (наратив) — text вливається в collectFinanceSnapshot → бачать і Порадник, і Чат;
--   рівень 2 (коригування числа) — adjust_kind/adjust_value рухають categoryMonthlyLevels,
--     але ЛИШЕ коли confirmed_at IS NOT NULL (гейт підтвердження: цифру пропонує AI, застосовує юзер).
-- category_id NULL = глобальний факт («я звільнився») — лише наратив, без коригування числа.
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,               -- «Метро подорожчало 8 → 30 ₴»
  effective_from INTEGER NOT NULL,  -- unix; з коли діє
  expires_at INTEGER,               -- NULL = безстроково
  category_id INTEGER,              -- NULL = глобальний факт (лише наратив)
  -- рівень 2 (опційний): коригування ЧИСЛА. Лише воно рухає burn.
  adjust_kind TEXT,                 -- 'multiplier' | 'delta_minor' | NULL
  adjust_value REAL,                -- multiplier: 3.75  |  delta_minor: +100000 (копійки/міс)
  confirmed_at INTEGER,             -- ⚠️ NULL = НЕ застосовувати до чисел
  source TEXT NOT NULL DEFAULT 'user', -- 'user' | 'ai_proposed'
  created_at INTEGER NOT NULL,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

-- Активні факти на «зараз» шукаємо часто (снапшот + override рівнів).
CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(effective_from, expires_at);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category_id);
