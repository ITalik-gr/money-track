# Round 2026-09-02 (b) — the owner's Statistics queue

Five items the owner reported from live use, plus the «Підписки» category decision. Companion to
`ROUND-2026-09-02.md`, which covers a different set from the same day (auto-budget, goals, advice
history). Durable rules have migrated into `docs/CANON.md` and `docs/UI.md`; this file keeps what
was OBSERVED and what the cause turned out to be.

---

## 1. Weekly and monthly reports arrived at noon — `DONE`

**Observed.** «Репорти тижневі та місячні щоб робились або на некст ранок, або краще ввечері, бо до
цього робило о 12 годині дня, а це майже весь день ще лишається витрачати.»

**Cause.** The cron triggers were `0 9 * * 1` and `0 9 1 * *` — 09:00 UTC, which is noon in Kyiv.
A summary of the week or the month that lands at lunchtime arrives after most of the day's
decisions are already made.

**Fix.** Both moved to `0 4` — 06:00–07:00 Kyiv depending on DST, waiting when the day starts.

**Evening was considered and rejected:** a period is not COMPLETE until it ends, so
`lastCompletePeriod` would report the week BEFORE the one just lived. A report that silently skips
a period is worse than one arriving a few hours late.

⚠️ **Consequence handled:** the reports now fire BEFORE the 06:00 UTC daily pass, where
`close_budget_month` lived. `runCron` closes the month for EVERY kind now — otherwise the 1st of the
month would report envelopes that had not yet received their carry (§BUDGET-MEMORY).

## 2. «Скільки коштувала конвертація» showed $ over hryvnia figures — `DONE`

**Observed.** «Коли зведення міняю на долари, то там показує знак долара, але по суті то гривні ж.»

**Cause — NOT in the conversion.** `lib/finance/fx.ts` and its route were correct. The Statistics
page has a currency FILTER that switches the page into one currency and threads its sign into every
block; `/analytics/fx-cost` takes no `currency` parameter and always answers in the reader's base.
So the sign came from the control and the numbers came from somewhere else. Two more blocks had the
identical defect: `MonthStack` and `ReceiptItems`. → §SIGN-FOLLOWS-DATA (`docs/UI.md`).

**Why no test caught it.** The §BASE-CUR sweep DID cover `/analytics/fx-cost` — but the fixture had
no foreign-currency purchase at all, so the endpoint answered `n: 0` and every assertion about it
held vacuously. The fixture now carries one, plus a `rate_history` row, and adding it immediately
exposed two further leaks in the test itself (a row keyed by `original_currency` was not recognised
as carrying its own currency; the rounding tolerance assumed a realistic rate).

## 3. Cumulative flow: the forecast was a straight line — `DONE` (§CASH-PROJ)

**Observed.** «Зараз просто бесполезний, предікт робить просто поступово кожен день знімає скільки в
середньому витрачаю, завжди лінія там рівно плавно вниз йде.»

**Cause.** Literally that: the projection was the MEDIAN daily net, repeated, computed in the client.

**Fix.** `worker/lib/finance/cash-projection.ts` + `GET /analytics/cash-projection`: the schedule by
date, ordinary spending shaped by the day-of-month and weekday profiles, and paydays detected by
rhythm. Full reasoning in `docs/CANON.md` §CASH-PROJ.

**On the owner's question about AI** («можна раз в день аі юзати, чи взагалі як ти пропонуєш»):
**no AI, and the reason is not cost.** Every input is already computed by this codebase for other
screens, so a model pass would be a SECOND opinion about numbers the app already has — the exact
shape of §CUR-PLAN, §REFUND and §A1-WRITE. If the model and the canon disagree, the chart and the
Advisor disagree about the same money, and nothing on screen says which is which.

## 4. Statistics in month mode showed data from somewhere else — `DONE`

**Observed.** «Деякі статистики в 0 місяці показують якісь рандомні данні.» Plus: the arrows look
unfinished, and the «Місяці» button is too similar to «Календарний».

**Cause.** Four blocks ignored `?ym=` and kept asking for the trailing preset: `SpendingPatterns`,
`PeriodCompare`, `WeekdaySpend`, `IncomeBreakdown`. In a month with no data they were the ONLY
blocks showing figures — which is why it read as random data rather than as a stale window.

**Fix.** `WeekdaySpend` and `IncomeBreakdown` now take explicit bounds (`/analytics/income` learned
`from`/`to`, the same shape `/analytics/compare` already had); `PeriodCompare` compares the shown
month against the one before it; `SpendingPatterns` is hidden — «Радар темпу» projects the month IN
PROGRESS by construction, and there is no pace left to project in a month that ended.

**Design.** The stepper's `‹ ›` were text glyphs inheriting the body font — replaced with the
rotated `chevron` icon every other control uses. «Місяці» carried the same pill AND the same
calendar icon as the period-mode toggle while doing something unrelated (one flips a setting, the
other leaves for another view); it now wears the stepper's chevron and an accent outline.

## 5. Subscription page: the plan line was unreadable over the bars — `DONE`

**Observed.** «Колір тексту на сторінці підписки, в Історія списань — за планом, все так же погано
видний на стовпцях.» — reported a second time after a first attempt at re-tinting it.

**Cause.** Recharts renders `ReferenceLine`'s `label` as plain text, so it sits ON the bars. No ink
colour survives a background that changes bar by bar — which is why re-tinting failed. The label is
now an opaque chip (surface fill, ochre border and text), placed above the line where there is room
and below it otherwise.

## 6. Retire the «Підписки» category — `DONE` (§SUBS-CAT, migration 0047)

Owner's decision: remove it; he had already re-filed his own transactions. «Стрімінги» moved under
«Розваги», «Софт і хмара» became top-level, and the category is deleted ONLY where nothing still
references it — twelve tables are checked. Reasoning in `docs/CANON.md` §SUBS-CAT.
