-- §TAX-* — ФОП: діловий дохід, офіційний курс, зобовʼязання (docs/TAX.md).
--
-- The whole module rests on one distinction: an ACCRUED obligation is not a PAID expense. The
-- categories «Податки/ЄП/ЄСВ/ВЗ» (24–28) have existed since 0005 and answer «where did the money
-- go»; nothing in the schema could answer «what do I already owe and have not paid». That is what
-- these tables are for, and why the accrual does not touch `transactions` at all.

-- §TAX-BASE — is this a business (ФОП) operation?
--
-- ⚠️ NULLABLE ON PURPOSE, and it is the load-bearing part of the design. Three states, not two:
--   NULL — nobody has been asked; inherit the account's answer
--   0    — a human said no, for THIS operation
--   1    — a human said yes, for THIS operation
-- Freezing 0/1 at ingest (the way `is_transfer` is frozen) would mean that marking an account as
-- a ФОП account later does not reach the history already imported — which is the normal order of
-- events: the account exists long before the app is told what it is for. Resolution is therefore
-- `COALESCE(t.is_business, a.is_business, 0)`, written ONCE, in `repo/tax.ts`.
--
-- ⚠️ NOT a category. §SUBS-CAT bought that lesson in full: the moment «business» becomes a place
-- in the taxonomy, one operation carries two answers to «what was this money spent on», and which
-- one wins comes down to who touched the row last.
ALTER TABLE transactions ADD COLUMN is_business INTEGER;
ALTER TABLE accounts     ADD COLUMN is_business INTEGER NOT NULL DEFAULT 0;

-- §TAX-FX — the tax base of ONE receipt, in hryvnia, frozen at the official rate of the day the
-- money arrived. Stored on the row rather than recomputed, because a filed declaration is frozen:
-- a later correction to a rate table must not silently rewrite a quarter that has been declared.
-- NULL for anything that is not business income (and for hryvnia rows, where it equals `amount`
-- and storing it would be a second copy of a number we already have).
ALTER TABLE transactions ADD COLUMN tax_base_uah INTEGER;

-- §TAX-FX — the National Bank's official rate for a date. Deliberately NOT `rate_history`.
--
-- `rate_history` holds the rates the app DISPLAYS money with (§BASE-CUR): a moving, roughly-right
-- market number whose job is to make today's screen readable. This holds the rate the STATE
-- computes tax with: official, tied to one date, and immutable once published. Sharing one table
-- would mean that fixing how a chart looks quietly edits a tax declaration.
--
-- `effective_date` is the date the rate is FOR, `fetched_for` the date that was asked about. They
-- differ over weekends and holidays, when the NBU publishes nothing and the previous working day's
-- rate applies — recording both means the fallback is visible in the data instead of being
-- re-derived (differently) by whoever reads it next.
CREATE TABLE nbu_rates (
  fetched_for    TEXT    NOT NULL,       -- 'YYYY-MM-DD', the date asked about (Kyiv, §APP_TZ)
  currency_code  INTEGER NOT NULL,       -- ISO 4217 numeric
  rate           INTEGER NOT NULL,       -- ₴ per 1 unit, in minor units ×10000 (see below)
  effective_date TEXT    NOT NULL,       -- 'YYYY-MM-DD', the date the NBU actually published for
  fetched_at     INTEGER NOT NULL,
  PRIMARY KEY (fetched_for, currency_code)
);
-- ⚠️ The rate is scaled ×10000, not stored as a float. Money is INTEGER minor units everywhere in
-- this project and a rate is the one place a float would sneak back in — 41.2537 ₴/$ times a
-- 4-figure invoice is exactly where a rounding difference turns into a hryvnia the declaration
-- does not have. Four decimal places is what the NBU itself publishes.

-- §TAX-DUE — one obligation: a kind, a period, an amount accrued, a deadline, and what paid it.
--
-- Rows are GENERATED from the rate table and the period's income, never typed in, and they are
-- rewritten while the period is open. `paid_tx_id` is a LINK, not a checkbox (§PLAN-LINK made the
-- same choice for subscriptions): with a link, «paid less than was accrued» is visible without a
-- second field to keep in sync, and the payment keeps its own place in the ledger.
CREATE TABLE tax_obligations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,          -- 'single_tax' | 'military_levy' | 'social_contribution'
  period      TEXT    NOT NULL,          -- 'YYYY-MM' for monthly, 'YYYY-Qn' for quarterly
  amount      INTEGER NOT NULL,          -- ₴ minor units, ACCRUED (§TAX-UAH: always hryvnia)
  due_date    TEXT    NOT NULL,          -- 'YYYY-MM-DD', Kyiv (§APP_TZ)
  paid_tx_id  TEXT    REFERENCES transactions(id),
  paid_at     INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (kind, period)
);
CREATE INDEX idx_tax_due ON tax_obligations(due_date);
