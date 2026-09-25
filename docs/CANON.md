# CANON.md — money, statistics, plans

> **Read FIRST before touching any number about money.** Canonical definitions: who counts a
> spend, which currency the app answers in, levels, budgets, subscriptions, goals. Every rule here
> was bought by a production bug; the full story of each is in git history / `HISTORY.md`.
>
> **One rule: new analytics are computed ONLY through `worker/lib/finance/stats.ts` and its
> neighbours.** Never duplicate SQL filters in endpoints — that is how §CUR-PLAN, §SUB-MONTH and
> §REFUND were born. Everything non-money → `CLAUDE.md`.

## Hard invariants

- Money is INTEGER minor units everywhere; divide by 100 only for display.
- Aggregate by `COALESCE(parent_id, id)` (sub-categories roll up into the parent).
- Credit limit is never mixed with own funds: own = `balance − credit_limit`, debt separately
  (`shared/own-funds.ts`, lint C14).
- A "never recompute in a component" rule applies to every canon below: the client draws, the
  server computes.

## Currency

- **§BASE-CUR — the answer currency is the READER's, not a constant.** Single source
  `worker/lib/finance/money.ts`: `resolveBaseCurrency(env)` (header `x-mt-currency` →
  `app_state.display_currency` → the language), `ratesInBase`, `getRates(env)`.
  - `getRates` returns rates IN THE READER'S BASE; the raw table is `getStoredRates`, reachable by
    two modules only (lint C10).
  - A base with no rate is refused (falls back to ₴; `/rates` returns the effective base).
  - Amounts the USER TYPED are stored in hryvnia (`budgets.amount`, `savings_goals`,
    `event_groups.budget`, `event_planned`, `facts.delta_minor`): read with `uahToBase`, write
    with `baseToUah`. A closed month (`budget_months`) is written in hryvnia.
  - The unit travels WITH the event: `insertDrafts` stamps `cur` into `notif_params`.
  - API fields ending in `*_uah` mean "minor units of the display base" (historical; renaming
    would blank stored reports). The model gets `moneyUnitDirective` (`lib/ai/prompt.ts`).
  - Client: `baseSign()` (`src/lib/currency.ts`), never a literal; dictionaries use `{cur}`,
    filled by `translate()`. Currency FOLLOWS the language (`onLocaleChange`) unless chosen
    explicitly; `x-mt-currency` is sent ONLY for an explicit choice (`currencyHeader()`).
    A branch that adopts the server language must invalidate caches like the one that pushes it.
  - Held by `check-i18n` + C10 + `worker/test/currency.test.ts`.
- Multi-currency: `transactions.currency_code` = ACCOUNT currency; `original_amount` /
  `original_currency` = operation currency. Roll-up only through rates.
- **Transfer pair = ONLY `transfer_pair_id`** (set by step 1 of `detectTransfers`). `is_transfer=1`
  does not collapse a pair (five paths set it). Holds pair too; a settlement amount change unpairs
  both sides (`repo.upsertMonoTx`) and the next detect pairs them again.

## Time and calendar

- **§APP_TZ — the calendar is Europe/Kyiv, not UTC.** No `new Date(x).getMonth()/getDate()/getDay()`
  for period bounds (lint C12); use `localMonthStart` / `localWeekStart` / `localDayStart` /
  `localYm` / `localParts` (`lib/finance/time.ts`, re-exported from `stats.ts`). SQL: `localFmtSql`,
  `localYmSql`, `localDowSql`, `localDomSql`. Where JS builds month keys and SQL groups, a missed
  key reads as a ZERO month.
  - A drill MUST use the same expression and moment as the chart above it.
  - A bare date from the model is Kyiv wall time (`localWallTime`), like §BANK-PARSE.
  - Counters (`ai_usage`, demo) are keyed by the Kyiv day.
  - Known limit: the offset is taken at query time for the whole window (DST edge rows may shift).
  - Held by `worker/test/app-tz.test.ts`.
- **`period_to` is the start of the NEXT period** — labels show `period_to − 1`.
- **Period:** `app_state.period_mode` (`calendar` | `rolling`); Home and Statistics share it.

## Accounts, plans, subscriptions

- **Account role (§R3):** `accounts.role` = `liquid` (default) | `investment`. Cushion/runway come
  from `liquid` only. Single source of funds: `fundsBreakdown()` →
  `{cushion, debt, investment, net, accounts[]}`. Net-worth reconstruction (`lib/finance/networth.ts`)
  walks accounts back one by one and composes with the same rule.
- **§CUR-PLAN — a plan's amount in base only via `plannedUAH()` / `sumPlannedUAH()`**
  (`subscriptions.ts`). `period_amount` is in the PLAN's currency; in SQL roll up with
  `uahMult(rates, "currency_code")`. **Never sum `period_amount` raw.**
- **§SUB-MONTH — monthly burden only via `monthlyPlannedUAH()` / `sumMonthlyPlannedUAH()`; the
  charge schedule only via `chargesBetween()`.** Two different questions: "how much per month"
  (averaging → AI context) vs "what will be charged before month end" (schedule → safe-to-spend,
  month forecast, cashflow calendar, liquidity dip). A window of days is a SCHEDULE: one item per
  OCCURRENCE (ids repeat in `/planned/upcoming`). `/planned` carries `monthly_base` — never
  multiply `period_amount` in a component. Held by `subscriptions.test.ts`.
- **Next charge — only `nextChargeUnix(startDate, period, count, now)`.**
- **§SUB-DATE — a monthly plan keeps ITS day:** each charge is computed from the start, the day
  clamped to month end, anchored to the Kyiv day.
- A subscription ≠ the «Підписки» category — the AI context gets the LIST of plans with
  categories (`subscriptions` + `subscriptions_note`).
- **§SUBS-CAT (migration 0047):** the «Підписки» category is gone — a subscription is a PROPERTY of
  the operation (`planned_id`). Its children moved («Стрімінги» → «Розваги», «Софт і хмара» is a
  root). The category is deleted only if nothing references it (all 12 tables checked).
- **§PLAN-LINK — a plan finds its own charges in history:** `linkPlanHistory`
  (`lib/finance/plan-match.ts`) on `POST /planned`, `PATCH /planned/:id`, re-sweep, and
  `POST /planned/:id/relink`. Linking (`planned_id`, always) and categorising (only when the plan
  has a category AND the row has none) are separate. Never overwrite a foreign category or
  reassign a foreign `planned_id`. `categorize()` asks about plans whatever decides the category
  (incl. a learned alias). Window 730 days, holds included. Pre-filter by ±10% AMOUNT in SQL,
  match the name in JS (SQLite folds case for ASCII only). Held by `plan-link.test.ts`.
- **§SUB-FIND / §SUB-ALIAS — match by the whole operation text:** `searchHaystack`
  (`repo/planning.ts`) / `txHaystack` (`subscriptions.ts`) = merchant + raw bank description +
  comment + `ai_note`. The model returns a LIST of brand names; terms shorter than `MIN_TERM = 3`
  are not searched; `likeVariants` sends both cases. `planNeedles`: a plan is also known by words
  of its `note` (≥ 4 letters, minus stop words); safe because currency and amount (±10%) must match.
- **§PLAN-REPRICE — a price change does not break a plan's identity** (`plan-match.ts`). When the
  name and currency match but the amount is outside ±10%, the charge is still the plan's IF it
  lands 1–3 declared cycles after the last LINKED charge (±⅕ cycle, ≥ 3 days), within ×3 of that
  charge, the cycle has no linked charge yet, and the plan has history — the time gate REPLACES the
  amount gate. Linking never touches `period_amount`; only `POST /planned/:id/accept-price` does,
  reading the amount from the ledger (409 across currencies). Held by `plan-reprice.test.ts`.
- **§PLAN-STATE — a plan says what happened to its latest cycle** (`plan-state.ts`, derived, never
  stored): `paid · changed · due · late · missing · stopped · ended · no_history`, on §PLAN-LATE's
  windows (3-day grace, half-period early tolerance). Cycles before the first linked charge are
  never «missed». While overdue, the card leads with the EXPECTED date, not the next one.
- **§SUB-STACK** (`lib/finance/sub-stack.ts`, `GET /planned/stack`): `monthly`/`count` over the
  SAME set as the Subscriptions hero (every active outflow plan, §SUB-MONTH); `paid` = what LINKED
  charges took per complete month (cancelled plans included), trimmed to the first observed month;
  `drift` = first 3 vs last 3 observed months (null under 6). Two-of-a-kind = ≥ 2 live
  subscriptions under one LEAF category, asked not asserted. Trial = first linked charge ≤ 10% of
  the median price since (`detectTrial`), announced for 90 days. The overview's `cancel` share uses
  §FLOW-SERIES income (same as §COMMITTED). No `annual` on the wire — it is `monthly × 12`.
  Held by `sub-stack.test.ts`.
- **§SUB-DETECT — a subscription is recognised by RHYTHM and PRICE, not exact amount**
  (`lib/finance/recurring.ts`, single source). The repo returns raw charges (`detectCharges`);
  grouping is by `coreToken`, amount buckets ±10% (same as `amountMatches`), `BUCKET_DOMINANCE`
  (0.6) separates a biller from a shop; the MEDIAN charge is proposed; a declared plan is
  excluded by all its names (`planNeedles`). Held by `recurring.test.ts` (FX subscription MUST be
  found, grocery shop MUST NOT).
- **§RHYTHM — `chargeRhythm` (`recurring.ts`), single source:** median of gaps (survives a hole);
  `day_of_month` in Kyiv, compared cyclically; a fixed-day plan is never warned about drift;
  gaps ≥ 1.5× median are shown (`skipped_gaps`) with a relink button.
- **§AI-RECURRING (migration 0046) — a subscription is proposed on the day of the FIRST charge.**
  `ai_recurring` NULL = not asked, 0/1 = answered. The guess stays BEHIND measurement (a merchant
  found by rhythm is not proposed twice; AI rows carry a badge). The prompt leans to `false`.
  Linked rows and bucket 13 are excluded.
- **§SUB-REVIEW (migration 0049) — the model is a JUDGE over the candidate list, not a third
  detector.** Verdict bill / not / unsure, STORED by a daily pass (the GET only reads). `not`
  hides nothing (shown folded under «AI відхилив»). Near-misses (`nearMissCandidates`: `shop` or
  `ragged`, exactly one soft gate failed) reach the screen ONLY with a `subscription` verdict;
  `too_few` / `one_month` / `cadence` are not near-misses. Key = `coreToken` (no price). A final
  verdict is never re-asked; `unsure` after 30 days. A person outranks the model. Held by
  `subs-review.test.ts`.
- **§PRICE-STEPS — "did it get pricier" is WHEN, not just "how much now":** `price_steps`, grouped
  with ±10%, compared only within one currency. One level is said in words, not hidden.
- **§SUB-PAGE — `/subs/:id` from `GET /planned/:id/overview`**
  (`lib/finance/subscription-overview.ts`): paid in total, price vs declared (in the charged
  currency), real cadence, per year, share. All numbers from the canon; a finished plan shows no
  next charge; no `STATS_JOINS` (a charge is a whole transaction). Held by `subscription-page.test.ts`.
- **§CAT-SUBS — «of which subscriptions» block on the category page:** share of the canonical
  monthly level, `null` where no level exists; a parent counts its children's plans.
- **§FK-GUARD — validate AI-returned category ids before writing** (`existingCategoryIds()`,
  `enrich.ts`): ids have holes, a plausible id can hit a missing row.
- **§INCOME-PLAN (migration 0044) — income has a SCHEDULE too.** Expected income is NEVER added to
  canonical `income` and is not in `safe`; it lives only in forecasts (`projectedIncome`).
  Overdue is DERIVED (`planned-to-date − received`, totals, no matcher). `OUTFLOW_ONLY` sits on
  EVERY selector in `repo/planning.ts`. Calendar and liquidity dip carry receipts as NEGATIVE
  amounts. `amount_varies` marks an estimate, not a range. Held by `income-plan.test.ts`.

## Goals and events

- **§GOAL-CUR (migration 0048) — a goal has ITS OWN currency:** `goalCurrency()`
  (`lib/finance/goals.ts`): the jar's currency if linked, else `currency_code`, else hryvnia.
  `/goals*` return numbers IN THE GOAL'S currency and name it. Relinking to a jar in another
  currency CONVERTS (`convertMinorBetween`). Whoever SUMS goals converts at the edge
  (`draftGoalRisk`, event verdict). Held by `goal-currency.test.ts`.
- **§GOAL-CHART — one series for both kinds:** `goalProgressSeries` → `GET /goals/:id/progress`.
  A manual goal ACCUMULATES contributions; a jar IS its balance (a level — never sum balances).
- **§GOAL-PACE — `goalPace()` ALONE** (pure, `goals.ts`), returned as `pace` on `/goals` and used
  by the drafter. Behind = gap ≥ 15 points between time elapsed and money saved; the final week is
  `at_risk`; under a month to the deadline `per_month === null` (fall back on `left`); start is
  `created_at`. Held by `goals.test.ts`.
- **§EVENT-GOAL (migration 0045):** `event_groups.goal_id`, `ON DELETE SET NULL`; the verdict is
  in WORDS («вистачило, лишилось 9 000») with numbers under it.

## Split and compensation

- **§SPLIT (migration 0021):** one expense split across categories (`tx_splits`). The ONLY
  integration point is `STATS_JOINS` + `EFF_AMOUNT = COALESCE(sp.amount, t.amount)` +
  `EFF_CAT_*` / `EFF_IMPORTANCE`. In any `STATS_JOINS` query spend = `-EFF_AMOUNT` (never
  `-t.amount`); and the mirror rule: a query using canonical helpers MUST have `STATS_JOINS`
  (SQL lint catches it). Count operations with `COUNT(DISTINCT t.id)`. Income and balance
  reconstruction ignore splits.
- **§COMPENSATION (migrations 0029 + 0030 v2):** one receipt is DISTRIBUTED across several
  expenses. Source of truth `tx_reimbursements(expense_id, source_tx_id, amount)`; denormalised
  `reimbursed` and `reimburses_total`, written ONLY by `/reimbursement` (`rbRecalc`). Canon:
  `EFF_AMOUNT` adds `reimbursed`; `EFF_INCOME = amount − reimburses_total`; `SPEND_WHERE` requires
  `reimburses_total = 0`; `INCOME_WHERE` requires `EFF_INCOME > 0`; `incomeSum` sums `EFF_INCOME`.
  Only the distributed part is compensation; the remainder is real income. Split and
  compensation are mutually exclusive.

## Statistics canon — `worker/lib/finance/stats.ts` (single source)

Used by every `/analytics` endpoint AND the AI context → **UI numbers = AI numbers.**

- **Spend:** `amount < 0` (or a refund), `transfer_pair_id IS NULL`, NOT (`is_transfer=1 AND
  real_category_id IS NULL`), effective category not 13 («Перекази і зняття»). Holds count
  (a closed hold rewrites the same id).
- **Effective category** = roll-up of `real_category_id`, else of `category_id`. Helpers:
  `EFF_CAT_*`, `SPEND_WHERE`, `INCOME_WHERE`, `STATS_JOINS`, `spendSum/incomeSum/amountSum`,
  `uahMult`, `valueMode`, `periodBounds/currentPeriodToDate/lastCompletePeriod`.
  `EFF_CAT_LEAF_ID` (no roll-up) answers only "which leaf did the row land in" — never aggregate by it.
- **Importance (§6, migration 0016):** `EFF_IMPORTANCE = COALESCE(t.importance, category
  importance, 'discretionary')`; `essential | discretionary | optional`. ⚠️ `t.ai_importance`
  (0054) is a model PROPOSAL and must never enter this COALESCE — it becomes canon only through
  `t.importance` (a person's click).
- **§REFUND — a refund is not income but a NEGATIVE spend of its category.** `IS_REFUND` =
  receipt, outside bucket 13, and (an existing non-income effective category OR a bank
  «Скасування…» description). Passes `SPEND_WHERE`, not `INCOME_WHERE`; not in `SPEND_COUNT`.
  `INCOME_WHERE` excludes bucket 13. `categoryMonthlyLevels` floors at 0.
- **§VOID-PAIR — a purchase and its cancellation are ONE feed row** (presentation only):
  `listFeed` returns `voided_by` / `voids`. Pair = same account, exactly opposite amount,
  cancellation 0–30 days later, refund prefix (`refundDescOn`), text ending with the merchant
  (or same MCC). One-to-one, latest match first; partial refunds stay two rows. Per-operation
  notification cards skip voided charges (`isVoidedExpr`). Held by `void-pair.test.ts`.
- **Recurring vs one-off (§E1):** `isRecurringExpr` — linked to a plan OR the merchant spent in
  ≥ 3 distinct months of the trailing window. `recurringOneoffSplit()`.
- **Category monthly level — `categoryMonthlyLevels()` (single source).** Fixed costs (stable last
  2–3 full months, CV ≤ 0.12) → average of the latest payments; variable → window average; full
  months only. **§A1:** confirmed facts adjust the level in `applyFactAdjustments()` at the end of
  this function — the ONLY place a fact moves a number. Lives in `lib/finance/levels.ts`.
- **§LEVEL-WINDOW — the denominator is the months the LEDGER covers, not the window length**
  (`coveredMonths`). A quiet month INSIDE the ledger stays in the denominator; the first month
  counts only if the ledger started in its first week (`FIRST_MONTH_GRACE_DAYS = 7`). Held by
  `level-window.test.ts`.
- **§A1-WRITE — a fact is created by `addFact` (`lib/ai/facts.ts`) ALONE**, with
  `source: "user" | "ai_proposed"` and `confirm`. A model-authored fact ALWAYS passes
  `confirm: false`. Held by `writes.test.ts`.
- **Monthly BURN (runway denominator) = `sumLevels(levels)`.** `runway = liquid cushion ÷ burn`.
  Exception: `/analytics/forecast.projectedSpend` is a different figure (this month's projection).
- **§BURN-SHAPE — burn says which part repeats:** `burnShape(levels)` (`levels.ts`);
  `recurring + lumpy === total === sumLevels`. Lump = one month holds ≥ 55% of the window OR active
  in ≤ half the covered months. Level, burn, runway, budgets are unchanged by it. Held by
  `burn.test.ts`.
- **Pace forecast — `projectSpend()`:** "spent + historical remainder", lumps (`n ≤ 1 OR biggest ≥
  55%`, or an unpaid fixed cost) not extrapolated, cap 3× usual.
- **Savings rate — `savingsRatePct(income, spend)`** (`lib/finance/finance.ts`); `null` at zero income.
- **§AI-AVGNAME — one field name, one quantity:** `avg_month_uah` is the canonical level;
  "90 days ÷ 3" is `per_month_90d_uah`.
- **§HEALTH — the health index is computed LIVE** on every `GET /analytics/health`
  (`lib/finance/health.ts`, arithmetic in the pure `scoreHealth`); one `health_history` row per
  Kyiv day, written by the page AND by the daily run (§HEALTH-TREND, with the four parts' points,
  migration 0055). Client cache tags = what it READS (`Tx`, `Account`, `Advice`). Savings rate
  compares fact with fact; stability SHOWS the clamped value, not `1 − cv`. A part the data cannot
  measure is UNMEASURED — left out, other weights renormalised — never graded: stability needs ≥ 2
  months, zero income is stability 0 (not 100). Parts' points sum EXACTLY to the score (largest
  remainder). Under half the formula measured = `insufficient`: no number or band on screen, not
  recorded. The AI gets the same index via `healthForModel` (§HEALTH-AI). Held by `health.test.ts`,
  `consistency.test.ts`.
- **§HEALTH-INCOME — a month WITHOUT income is a month and counts** (via `fullyCoveredMonths`,
  which — unlike `coveredMonths` — never falls back to months the ledger does not have).
- **§IMPORTANCE-TREND:** `importanceByMonth` → `essential/discretionary/optional` in
  `/analytics/monthly-history`; the three shares sum to `spend`. `GROUP BY` the expression, not the alias.

## Budgets — `budgetStatus(env, mult, now)` (`lib/finance/budgets.ts`, single source)

Spend = canon, rolled up to the parent, month from its first day. Readers: feed
(`drafts-budget.ts`), TG push, per-transaction alert, `GET /budgets/status` → `EnvelopeGrid`.
The client never derives it.

- **§BUDGET-MEMORY (migration 0043):** `budget_months(ym, category_id, limit_minor,
  carry_in_minor, spent_minor)`, closed by `closeBudgetMonths` in the DAILY pass (before
  notifications), `INSERT OR IGNORE`, never rewritten. `amount` = effective limit
  (`base_amount + carried`); overspend carries too (negative), capped at ±base limit. No closed
  month → no carry. Autobudget `trackRecord` (6 closed months, min 2): failed half the time →
  `trim` dropped (`basis: "missed"`). `setMonthlyBatch` keeps `rollover`. `budgetHistory(env)`
  judges a month by the WHOLE plan. Closed months are in ₴ → convert on read. Held by
  `budget-memory.test.ts`.
- **§BUDGET-ZERO — limit 0 is a PLAN.** Row exists = envelope; removal is `DELETE
  /budgets/:categoryId`; negative → 400; `ratio` is binary, no bar, no rollover; an empty field ≠ 0.
- **§BUDGET-FORECAST:** `projected` from the same `projectSpend`; `lumpy` exposed. The
  `budget_forecast` notification: not before the 10th, not when `ratio ≥ 0.9`, not for lumps,
  only from 110% + 200 ₴, once per envelope per month.
- **§BUDGET-PACE:** `pace_ratio = spent / elapsedFrac` (this month only); `draftBudgetForecast`
  also requires `pace_ratio ≥ 1`. Held by `budget-pace.test.ts`.
- **§BUDGET-REACH — a limit BELOW the app's own level is reported, never auto-fixed**
  (`unreachable`, `level` beside it). Threshold 15% and ≥ 2 active months; never for a zero envelope.
- **§ENV-PARTS — what the month is made of:** `envelopeParts` (`lib/finance/envelope-parts.ts`):
  `committed` (linked to a plan) + `rhythmic` (measured rhythm, §SUB-DETECT) + `discretionary`
  = `spent`. No third definition of "recurring"; rhythm window 400 days; query narrowed to
  merchants active this month. `floor = committed + rhythmic`; `floor > effective limit` →
  `floor_over_limit` (true from the 3rd; not a zero envelope). `proposeBudgets` gets
  `committed_floor_uah` and RAISES the model's proposal to it in code (never lowers). Held by
  `envelope-parts.test.ts`.

## Insights and statistics blocks

- **§CADENCE — "is this delta a change or the calendar"** (`lib/finance/cadence.ts`): periods
  shorter than 28 days need ≥ 2 charges on BOTH sides (`deltaMeaningful`, counted with
  `SPEND_TX_COUNT`). `/analytics/compare` returns merged `rows` and `movers`; the noise floor is
  `MOVERS_FLOOR_UAH_MINOR` converted. A meaningless delta is shown without colour. Reports carry
  `charges_n`, `monthly_usual_uah`, `billing`, `delta_meaningful`. Held by `cadence.test.ts`.
- **§FX-EXPOSURE** (`lib/finance/fx-exposure.ts`, `GET /insights/fx-exposure`): assets =
  `computeSummary().byCurrency` converted (sums to `/summary` total); spend = canonical spend by
  the OPERATION currency (`COALESCE(original_currency, currency_code)`), monthly over 3 complete
  months; what-if = every non-base currency +10% vs the READER's base — base-relative by
  definition, so excluded from the §BASE-CUR sweep and pinned by `fx-exposure.test.ts`. A what-if,
  never worded as a forecast.
- **§FX-COST — what conversion cost** (`lib/finance/fx.ts`): each side valued at ITS day's rate,
  compared in ₴, converted once; a day without a stored rate is skipped and counted (`unpriced`);
  no `STATS_JOINS`. Held by `fx-cost.test.ts`.
- **§WEEKDAY** (`lib/finance/weekday.ts`): weekday in Kyiv, divided by the number of such days
  (`typical`), `busiest` among non-lump days; the advisor sees the same data. Day of month:
  `buildDomAnalytics` → `GET /analytics/day-of-month`. Held by `calendar-shape.test.ts`.
- **§HABITS** (`lib/finance/habits.ts`): new = ≥ 2 of the last 3 full months and 0 of the 3
  before; silent = ≥ 3 of the previous 6 and 0 in the last 2; current month excluded; `monthly`
  averages active months. Held by `habits.test.ts`.
- **§SHAPE** (`lib/finance/spending-shape.ts`, `GET /analytics/spending-shape`): cheque size
  (whole transaction, `-t.amount`), share outside envelopes, uncategorised in money. Bucket edges
  `CHEQUE_STEPS_UAH_MINOR` are fixed and converted; mind `NULL NOT IN (…)`. Held by
  `spending-shape.test.ts`.
- **§MONTH-VIEW / §MONTH-STACK:** `?ym=` turns Statistics into a PAST month only; "now" blocks
  hide and say why; the period switch is replaced by month navigation. Stack: `categoryByMonth`
  (top 8 + other), segments declared once per window, segments sum to the month exactly,
  current month excluded.
- **§SPEND-PROFILE** (`lib/finance/spend-profile.ts`): quiet days, merchants making half the spend,
  money to new merchants — one population (`SPEND_WHERE` + `STATS_JOINS`), merchant = `coreToken`,
  a refund is not a visit, today excluded.
- **§MOMENTUM** (`momentum.ts`): full months only, a run is THREE steps one way, each step crosses
  a percentage AND a converted money floor, walks back from the last full month, sorted by money.
- **§INCOME-SPLIT** (`income-allocation.ts`): importance levels as a share of INCOME; `left` can
  be negative; no income → `shares: null`. `amountSum` already returns spend POSITIVE.
- **§FLOOR** (`lib/finance/floor.ts`): floor = `burnShape(levels).recurring`, total = `sumLevels`;
  two runways, the full one stays primary; `lumpy` ≠ "optional".
- **§FLOW-SERIES** (`lib/finance/flow-series.ts`): income and spend per COMPLETE month the ledger
  fully covers, zero-filled — the ONE «typical month's income» (`seriesMean`). Empty for an empty
  or brand-new ledger, and every reader treats empty as unmeasurable, not zero. Read by §HEALTH
  and §COMMITTED.
- **§COMMITTED** (`lib/finance/committed.ts`, `GET /insights/committed`): §FLOOR's floor ÷
  §FLOW-SERIES income; `free = income − floor` (may be negative), `share` may exceed 1. Plans are
  NOT added (a repeating subscription is already in the floor); the tax reserve is NOT in it (an
  outstanding total, not a rate). Trend = the same two functions as of each of the last 6 month
  starts; a point without income is dropped. Held by `insights.test.ts` (its floor IS §FLOOR's).
- **§INCOME-CV** (`incomeCv`, `flow-series.ts`): population stddev ÷ mean over a ZERO-FILLED series
  of the 6 complete covered months; null under 2 months or a zero mean. ONE definition for the
  health index's stability, `/analytics/income` `stability.cv_pct` and §INCOME-RHYTHM (the income
  card used to average only months that had income — the §HEALTH-INCOME bug). Held by
  `income-rhythm.test.ts`.
- **§INCOME-RHYTHM** (`lib/finance/income-rhythm.ts`, `GET /insights/income-rhythm`): longest gap
  between arrivals (the running one included), days since the last, months with income ≥ §FLOOR,
  and §INCOME-CV. Arrivals are §PAYDAY-EFFECT's events.
- **§PAYDAY-EFFECT** (`lib/finance/payday-effect.ts`, `GET /insights/payday`): receipts = canonical
  income ≥ ¼ of the §FLOW-SERIES typical month, merged within 3 days; discretionary = `SPEND_WHERE`,
  not plan-linked, not `essential`; after-week vs the window's average week (from the ledger's
  first row); only full weeks inside the last 6 complete months; < 3 events → null. Held by
  `payday-effect.test.ts` (a ledger WITH the effect and one without).
- **§CASH-PROJ** (`lib/finance/cash-projection.ts`, `GET /analytics/cash-projection`): scheduled
  money by date (`cashflowMoves`) + ordinary spend shaped by day-of-month/weekday weights +
  paydays (`detectPaydays`, median). No AI. The TOTAL is preserved, only the shape moves; ordinary
  spend excludes plan-linked rows; day weight clamped 0.25–2.5×; a dated plan beats a detected
  payday; forecast income is never canonical income; step days with `localDayStart`. Held by
  `cash-projection.test.ts`.

## Category pages

- **§CATEGORY-PAGE — `/categories/:id`** from `GET /categories/:id/overview`; default window = the
  MONTH (matches `budgetStatus`).
- **§CAT-PAGE:** `CatScope {id, isParent, isIncome}` resolved once (`catWhere` / `catSum` in
  `repo/categories.ts`); sub-categories match via `EFF_CAT_LEAF_ID`; income categories have their
  own view; lifetime stats independent of the window; trend 24 months; `per_active_month` divides
  by active months; level and envelope only for a top-level spend category in the current month.
  Same scope in `lib/finance/category-drill.ts`. Held by `category-page.test.ts`.
- **§CAT-PARTS:** rows selected by roll-up, grouped by leaf; the parent's own rows are a `self`
  share; shares sum to the page total; the trend starts at the category's first operation.
- **§CAT-SHARE:** `share_of_total_pct` = the category's window total ÷ `periodTotals` over the SAME
  window (spend; income for an income category), 0.1 precision; the shares of all top-level spend
  categories sum to 100 (`category-page.test.ts`). Category 13 reports 0.
- **§CAT-SETTINGS / §SUB-SETTINGS:** a category's importance, monthly envelope (top-level spend, month
  view only) and name, and a plan's amount/period/count, category and other-names note, are edited
  on their own pages, by explicit action. `PATCH /planned/:id` validates the schedule (integer
  amount > 0, `month|week`, count 1–24) and re-links history after any change.
- **§CAT-SHAPE** (`GET /categories/:id/shape`, `lib/finance/category-shape.ts`): importance
  inside the category, when money goes, how the month ends. Needs a SAMPLE (≥ 2 observations per
  bucket: weekday from 14 charges, day of month from 2 months); `null` is a REFUSAL, not zero; no
  forecast where an envelope already shows one; no importance for income. Held by
  `category-shape.test.ts`.

## Search

- **§QUERY-PARSE** (`lib/finance/query-parse.ts`, pure; `query-search.ts` feeds it): the search box
  reads a sentence — amounts (`понад/менше/від/до/over/under/>/<`, ranges), Kyiv periods (relative,
  month names = latest non-future occurrence, years), income/spend words, a category (longest
  Cyrillic-folded name, inflections via a stem), exclusions (`без/крім/except/-x`). Every piece is a
  chip (`GET /transactions/parse`); unrecognised words stay text, each must match (§CYR-CASE). Used by
  the feed (`smart=1`, explicit panel filters win) AND by `find_transactions` (chat + MCP). A number
  directly before a month word is never an amount. Held by `query-parse.test.ts`.

## Categorisation (deterministic first, AI last)

Order in `categorize()` / `enrich()`: learned `merchant_alias` (exact) → active subscription
(merchant + amount + currency) → merchant consensus (root name ≥ 3×, ≥ 80% one category) →
`mcc` / `text` rules → AI enrich (Jev → Haiku).

- Alias `source` (`manual` | `ai`, 0014): AI never overwrites manual; re-sweep skips manual;
  consensus weighs manual ×3.
- **§RULES-UI — rules are editable in the app** (`/rules/*`, preview, apply). Save is locked until
  Check ran; `apply` touches ONLY uncategorised operations; the text a `text` rule matches is ONE
  for engine and preview (raw bank `description` + `comment`; `textHaystack` in `repo/rules.ts`).
  To beat a factory MCC rule, create an `mcc` rule with priority > 10.
- **§WHY-CATEGORY** (`GET /transactions/:id/why`, `services/tx-insight.ts` `explainCategory`):
  RUNS `categorize()` and says which step answered — the state of rules NOW, not history; a
  mismatch is shown, never "fixed"; explains the RAW description.
- **§SIMILAR** (`GET /transactions/:id/similar` + bulk): similarity = `coreToken`
  (`lib/finance/merchants.ts`, single definition); only rows that would CHANGE are listed;
  `suggested` is decided by the server (uncategorised = ticked, other category = offered, not
  ticked); no "apply to all" button. Held by `similar.test.ts`.
