-- §COMPENSATION v2: одне надходження — на КІЛЬКА витрат, частинами.
--
-- Чому 0029 виявилась замалою (знайдено на реальних даних): P2P-надходження, БІЛЬШЕ за витрату,
-- яку воно компенсує. Модель 0029 дозволяла привʼязати надходження РІВНО до однієї витрати
-- і обрізала суму стелею витрати. Наслідок: різниця зависала — вона не йшла ні на іншу витрату,
-- ні в дохід, бо `reimburses_id` виключав УСЕ надходження з `INCOME_WHERE`. Тобто гроші
-- просто зникали зі статистики.
--
-- Нова модель — розподіл (allocation), а не привʼязка:
--   tx_reimbursements(expense_id, source_tx_id, amount) — скільки САМЕ з цього надходження
--   пішло на цю витрату. Одне надходження може мати кілька рядків на різні витрати.
--
-- Дві денормалізовані суми лишаються на `transactions` — і це навмисно:
--   reimbursed        — скільки компенсовано ЦІЙ витраті (сума розподілів по expense_id).
--   reimburses_total  — скільки з ЦЬОГО надходження вже розподілено (сума по source_tx_id).
-- Канонічний `EFF_AMOUNT` читає лише `t.reimbursed`, а дохід — лише `t.reimburses_total`,
-- тож найгарячіший вираз проєкту не отримує жодного нового JOIN. Таблиця потрібна лише
-- на запис і для UI. Єдиний писар обох сум — ендпоінт `/reimbursement`.
--
-- Дохід тепер рахується від ЗАЛИШКУ (`amount - reimburses_total`), а не «все або нічого»:
-- нерозподілений залишок — це справді дохід, і він має бути в доході.

CREATE TABLE IF NOT EXISTS tx_reimbursements (
  id           INTEGER PRIMARY KEY,
  expense_id   TEXT    NOT NULL,
  source_tx_id TEXT    NOT NULL,
  amount       INTEGER NOT NULL,           -- копійки, ДОДАТНЕ, у валюті обох операцій
  created_at   INTEGER NOT NULL,
  UNIQUE (expense_id, source_tx_id)        -- одна пара = один рядок; сума правиться, не дублюється
);

CREATE INDEX IF NOT EXISTS idx_txr_expense ON tx_reimbursements(expense_id);
CREATE INDEX IF NOT EXISTS idx_txr_source  ON tx_reimbursements(source_tx_id);

-- Скільки з надходження вже роздано по витратах.
ALTER TABLE transactions ADD COLUMN reimburses_total INTEGER NOT NULL DEFAULT 0;

-- Перенос даних 0029: наявна привʼязка стає розподілом на суму `reimbursed` тієї витрати.
INSERT OR IGNORE INTO tx_reimbursements (expense_id, source_tx_id, amount, created_at)
SELECT e.id, s.id, MIN(s.amount, e.reimbursed), CAST(strftime('%s','now') AS INTEGER)
FROM transactions s
JOIN transactions e ON e.id = s.reimburses_id
WHERE s.reimburses_id IS NOT NULL AND e.reimbursed > 0;

UPDATE transactions SET reimburses_total = COALESCE(
  (SELECT SUM(r.amount) FROM tx_reimbursements r WHERE r.source_tx_id = transactions.id), 0);

-- `reimburses_id` більше не існує як поняття: надходження не «належить» одній витраті.
DROP INDEX IF EXISTS idx_tx_reimburses;
ALTER TABLE transactions DROP COLUMN reimburses_id;
