// Deterministic dataset for the P0.0 spike. Both backends (D1 and the DO's SQLite) get
// exactly these rows, so any difference in the query results is a difference in the
// engine/driver — not in the data.
//
// The fixture deliberately covers every construct the canonical SQL in `lib/stats.ts` cares
// about, because those are the only queries whose behaviour actually has to be proven:
//   • a split expense (§SPLIT — STATS_JOINS fans the row out into parts)
//   • an expense partially covered by an incoming payment (§COMPENSATION v2 — reimbursed /
//     reimburses_total, where the unallocated remainder must still count as income)
//   • a refund ("Скасування…") which is a NEGATIVE EXPENSE, not income (§REFUND)
//   • both sides of a transfer pair (transfer_pair_id) and a one-sided is_transfer row
//   • a foreign-currency row (uahMult conversion) and a hold
//   • an uncategorised expense (NULL category must still count as spend)
// Timestamps are fixed (2026-03) so aggregates are reproducible run to run.

const T = (day: number, hour = 12) => Math.floor(Date.UTC(2026, 2, day, hour) / 1000);

export const SPIKE_FIXTURE_SQL = `
DELETE FROM tx_reimbursements;
DELETE FROM tx_splits;
DELETE FROM transactions;
DELETE FROM accounts;

INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_manual, is_active, updated_at) VALUES
  ('acc_uah',  'black',  'Чорна картка', 980, 1500000, 0,      0, 1, ${T(1)}),
  ('acc_usd',  'white',  'Долари',       840,  120000, 0,      0, 1, ${T(1)}),
  ('acc_cred', 'platinum','Кредитка',    980,  200000, 2000000, 0, 1, ${T(1)});

INSERT INTO transactions
  (id, account_id, source, time, amount, currency_code, mcc, category_id, real_category_id,
   merchant, comment, hold, is_transfer, transfer_pair_id, reimbursed, reimburses_total, created_at)
VALUES
  -- plain expenses in the base currency
  ('tx_food1',  'acc_uah', 'mono', ${T(2)},  -45000,  980, 5411, 1, NULL, 'Сільпо',      NULL, 0, 0, NULL, 0, 0, ${T(2)}),
  ('tx_food2',  'acc_uah', 'mono', ${T(5)},  -32050,  980, 5411, 1, NULL, 'Лідл',        NULL, 0, 0, NULL, 0, 0, ${T(5)}),
  ('tx_cafe',   'acc_uah', 'mono', ${T(7)},  -18900,  980, 5812, 2, NULL, 'Кава',        NULL, 1, 0, NULL, 0, 0, ${T(7)}),
  -- uncategorised expense: NULL category must still be counted as spend
  ('tx_nocat',  'acc_uah', 'mono', ${T(8)},  -7700,   980, NULL, NULL, NULL, 'Кіоск',    NULL, 0, 0, NULL, 0, 0, ${T(8)}),
  -- split expense: one purchase, two categories (rows fan out via STATS_JOINS)
  ('tx_split',  'acc_uah', 'mono', ${T(9)},  -120000, 980, 5411, 1, NULL, 'АТБ',         NULL, 0, 0, NULL, 0, 0, ${T(9)}),
  -- foreign currency spend (uahMult conversion path)
  ('tx_usd',    'acc_usd', 'mono', ${T(10)}, -2500,   840, 5732, 9, NULL, 'Steam',       NULL, 0, 0, NULL, 0, 0, ${T(10)}),
  -- refund: positive amount, expense category → negative expense, NOT income (§REFUND)
  ('tx_refund', 'acc_uah', 'mono', ${T(11)}, 14500,   980, NULL, 3, NULL, 'Скасування. BlaBlaCar', NULL, 0, 0, NULL, 0, 0, ${T(11)}),
  -- expense partially covered by an incoming payment (§COMPENSATION v2)
  ('tx_dinner', 'acc_uah', 'mono', ${T(12)}, -187000, 980, 5812, 2, NULL, 'Ресторан',    NULL, 0, 0, NULL, 100000, 0, ${T(12)}),
  ('tx_p2pin',  'acc_uah', 'mono', ${T(13)}, 240000,  980, NULL, NULL, NULL, 'Від: Михайло', NULL, 0, 0, NULL, 0, 100000, ${T(13)}),
  -- salary: plain income
  ('tx_salary', 'acc_uah', 'mono', ${T(3)},  4500000, 980, NULL, 15, NULL, 'ЗП',         NULL, 0, 0, NULL, 0, 0, ${T(3)}),
  -- transfer pair: both sides carry transfer_pair_id and must vanish from both aggregates
  ('tx_trf_out','acc_uah', 'mono', ${T(14)}, -500000, 980, NULL, 13, NULL, 'На банку',   NULL, 0, 1, 'pair1', 0, 0, ${T(14)}),
  ('tx_trf_in', 'acc_cred','mono', ${T(14)},  500000, 980, NULL, 13, NULL, 'З картки',   NULL, 0, 1, 'pair1', 0, 0, ${T(14)}),
  -- one-sided transfer with no real category: excluded from spend by SPEND_WHERE
  ('tx_cashout','acc_uah', 'mono', ${T(15)}, -300000, 980, 6011, 13, NULL, 'Зняття',     NULL, 0, 1, NULL, 0, 0, ${T(15)});

INSERT INTO tx_splits (tx_id, category_id, amount, created_at) VALUES
  ('tx_split', 1, -80000, ${T(9)}),
  ('tx_split', 8, -40000, ${T(9)});

INSERT INTO tx_reimbursements (expense_id, source_tx_id, amount, created_at) VALUES
  ('tx_dinner', 'tx_p2pin', 100000, ${T(13)});
`;
