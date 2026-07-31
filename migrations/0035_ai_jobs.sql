-- §A6 — довгі AI-генерації виконуються у ФОНІ, а не в тілі HTTP-запиту.
--
-- Чому таблиця, а не пам'ять ізоляту: Durable Object можуть евіктнути між постановкою задачі
-- й alarm'ом, і черга в пам'яті зникла б разом із ним — користувач лишився б із вічним
-- «генерується». Рядок переживає евікшн, тож alarm після пробудження бачить роботу.
--
-- Лежить у БД ЮЗЕРА (DO), а не в спільній directory: це його дані й його рахунок за модель,
-- і воркер до них не має ходити.
CREATE TABLE IF NOT EXISTS ai_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'advisor' | 'report' | 'budget'. Чат свідомо НЕ тут: це діалог, його чекають.
  kind         TEXT    NOT NULL,
  -- 'queued' (поставлена, alarm ще не забрав) | 'running' | 'done' | 'failed'.
  status       TEXT    NOT NULL,
  params_json  TEXT,
  -- Результат лише для видів, які не мають власного сховища (budget). advisor пише в
  -- app_state.advisor, report — в ai_reports, тож у них тут NULL і клієнт просто інвалідує тег.
  result_json  TEXT,
  error        TEXT,
  -- Скільки разів alarm брався за цей рядок. Існує, щоб задача, яка падає ДО того, як встигне
  -- позначитись 'failed', не лишалась 'queued' навіки: планувальник переармовується саме на
  -- наявність черги, тож такий рядок крутив би alarm нескінченно (і платно).
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  -- Коли клієнт показав тост про завершення. NULL = ще не показано, зокрема після
  -- закритої вкладки — саме звідси береться «завершені й не показані» при наступному вході.
  seen_at      INTEGER
);

-- Обидва читання гарячі: alarm шукає роботу, клієнт — активні + непоказані.
CREATE INDEX IF NOT EXISTS idx_ai_jobs_status ON ai_jobs (status, id);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_seen ON ai_jobs (seen_at, finished_at);
