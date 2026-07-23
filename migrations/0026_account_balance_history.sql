-- Історія ручних балансів рахунку. Зріз балансу «на момент часу» — дає ЧЕСНИЙ нетворт назад
-- для ручних/крипто-рахунків, які не мають tx-історії: реконструкція `/analytics/networth`
-- крокує по цих точках замість того, щоб лишати баланс плоским до сьогоднішнього зрізу.
--
-- Пишеться при СТВОРЕННІ ручного рахунку та при кожній РУЧНІЙ зміні балансу (кнопка «Зберегти»).
-- balance — копійки у ВАЛЮТІ рахунку (як accounts.balance); зведення в ₴ — на етапі реконструкції.
CREATE TABLE IF NOT EXISTS account_balance_history (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,
  balance INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_abh_acc_time ON account_balance_history(account_id, recorded_at);
