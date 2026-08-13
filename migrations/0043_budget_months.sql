-- §BUDGET-MEMORY — the time dimension `budgets` never had.
--
-- `budgets` is ONE row per category: `category_id, period, amount`. No month, no history. So an
-- envelope could only ever say "70% right now" — it could not say "you closed July with room to
-- spare", and it could not answer "is this getting better", which is the only question that makes
-- a budget worth keeping.
--
-- It also left `budgets.rollover` (migration 0017, ~10 months old) as a switch that did NOTHING:
-- `budgetStatus` never read it. The Plan page derived a carry-over in the CLIENT from last month's
-- `/analytics/by-category`, so the plan screen showed one effective limit while the envelope grid,
-- the notification feed and the Telegram push all showed another for the same envelope.
--
-- One row per (month, category), written when a month CLOSES:
--   * `limit_minor`    — the limit that was in force at the close. There is no historical limit to
--                        recover, so this row is the only record that will ever exist of it.
--   * `carry_in_minor` — what this month started with on top of its limit (may be NEGATIVE).
--   * `spent_minor`    — the canonical spend for the month (`budgetStatus`, same definition as
--                        every other screen). Stored, not recomputed: the carry chain is built on
--                        it, and a chain that silently re-derives its own history moves whenever a
--                        transaction is re-categorised months later.
CREATE TABLE budget_months (
  ym             TEXT    NOT NULL,             -- київський '2026-07'
  category_id    INTEGER NOT NULL REFERENCES categories(id),
  limit_minor    INTEGER NOT NULL,
  carry_in_minor INTEGER NOT NULL DEFAULT 0,
  spent_minor    INTEGER NOT NULL,
  closed_at      INTEGER NOT NULL,             -- unix, коли крон закрив місяць
  PRIMARY KEY (ym, category_id)
);

-- Reading is always "this category, recent months first" — the envelope's own history strip and
-- the carry lookup for the month being opened.
CREATE INDEX idx_budget_months_cat ON budget_months(category_id, ym DESC);
