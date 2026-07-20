-- Центр сповіщень (ROADMAP §Черга 2, v1 = in-app only). Стрічка того, що система
-- «хоче сказати»: готові репорти, дедлайни списань, аномалії темпу, перевитрата бюджету,
-- подорожчання підписки, провал ліквідності.
--
-- dedup_key — ОБОВʼЯЗКОВИЙ і UNIQUE: добовий крон генерує ті самі події щодня, тож
-- вставка йде через INSERT OR IGNORE. Ключ мусить містити «період актуальності»
-- (місяць для аномалії, дату списання для дедлайну), інакше подія ніколи не повториться.
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,           -- 'report'|'deadline'|'anomaly'|'budget'|'price_up'|'liquidity'
  title       TEXT NOT NULL,
  body        TEXT,                    -- людський текст із канонічними цифрами
  severity    TEXT NOT NULL DEFAULT 'info',  -- 'info'|'warn'|'urgent'
  entity_type TEXT,                    -- 'report'|'planned'|'category'|'tx'|NULL
  entity_id   TEXT,                    -- id сутності (TEXT, бо transactions.id рядковий)
  dedup_key   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER,
  pushed_tg_at INTEGER                 -- зарезервовано під TG-пуш (severity >= warn), v1 не пише
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(dedup_key);
CREATE INDEX IF NOT EXISTS idx_notifications_feed ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, created_at DESC);
