-- Тренд Індексу фінздоров'я в часі. Історія не рахувалась ретроспективно (потрібні історичні
-- funds/levels), тож фіксуємо СКОР щодня при перегляді: /analytics/health робить upsert за днем.
-- day — 'YYYY-MM-DD' (один запис/добу), score 0..100.
CREATE TABLE health_history (
  day   TEXT PRIMARY KEY,
  score INTEGER NOT NULL,
  ts    INTEGER NOT NULL
);
