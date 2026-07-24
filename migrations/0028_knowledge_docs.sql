-- §A5 lvl-up: користувацький шар корпусу знань.
-- Вбудовані доки лишаються в коді (`worker/lib/knowledge/*`) — вони версіонуються разом із
-- застосунком. Тут живе ЛИШЕ те, що додав/переписав користувач:
--   kind='user'     — власний документ (id = 'user:<timestamp>');
--   kind='override' — заміна тіла вбудованого доку (id = id вбудованого).
-- Документ «Як Money Track рахує цифри» навмисно НЕ можна ні перезаписати, ні вимкнути:
-- він описує канон розрахунків, і розходження з ним = AI, що пояснює цифри не так, як їх
-- рахує застосунок (та сама помилка, що «домислена подушка»).
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_kind ON knowledge_docs(kind, created_at);
