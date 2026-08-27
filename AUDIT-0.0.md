# §0.0 — the owner's live-use queue (opened 2026-08-27)

Working file for ROADMAP §0.0. **Only the diagnosis and the state of each fix live here** — once a
block is delivered, the durable rule goes to `CLAUDE.md` and the card leaves `ROADMAP.md`.

Findings below were verified against the owner's REAL data through the Money Track MCP server, not
read off the code. Where a figure is quoted it was measured on 2026-08-27.

---

## A. Subscriptions — "бредово працює"

### A1. 404 on a linked charge — DONE
`src/pages/Subscription.tsx` linked a charge to `/transactions/<id>`. That is the **API** prefix;
the ROUTER path is `tx/:id` (`App.tsx`). It was the only `<Link>` in the whole client using the
API prefix — every other one of the eight writes `/tx/${id}` — which is why nobody saw it: the two
namespaces agree almost everywhere.

### A2. "no charges" printed directly above the charges — DONE
The chart was gated on `chart.length > 1`, the linked-transactions section on `charges.length > 0`.
With EXACTLY ONE charge the page said «списань не видно» and then listed the charge under it.
Three states, not two: none / one (no history to plot, but not empty) / many.

### A3. A plan never links its own history — DONE (the root cause)
`transactions.planned_id` was written in exactly two places: at INGEST, and inside
`applySubscriptionCategories` — a button in Settings nobody knows about. `POST /planned` created
the row and did nothing else.

Consequence chain, all from one gap: a plan added by hand has zero charges → the page says «списань
не видно» → the feed says the same → `plannedActuals` shows nothing → "did it get more expensive"
is unanswerable — while every charge sits in the table beside it.

Two gates made it worse:
- `activeSubs` required `category_id IS NOT NULL`, and the manual add form does not ask for a
  category at all → a hand-added plan matched nothing, ever, not even on ingest.
- linking and categorising were ONE action, so a plan without a category could not link either.

### A4. Detection groups by EXACT amount and EXACT merchant — DONE
`detectCandidates` did `GROUP BY t.merchant, t.amount HAVING n >= 2 AND months >= 2`.
A foreign-currency subscription billed to a hryvnia card costs a different amount every month, so
each charge formed its own group with `n = 1` and was **never** proposed — which is most of the
owner's actual subscriptions. «X Corp.» / «X Corp» split the same way. Nothing checked RHYTHM: exact
amount equality was doing that job, badly.

---

## B. Statistics the owner does not trust — burn says 44k

**Measured:** full months Apr 42 618 · May 39 116 · Jun 35 442 · Jul 46 581 (Aug 25 345, partial).
Mean of the four = **40 939**. `monthly_burn_uah` = **44 784** — 9.4% above the mean of the very
window it is computed from, and above every month but July.

Four causes, each sufficient on its own:
1. **The `fixed` branch drops zero months from its own denominator** (mean of the last ≤3 NONZERO
   months), while a variable category divides by every covered month. A sum of levels built that
   way cannot equal the mean month.
2. **The per-category floor of 0** breaks the offset: a net-negative category (§REFUND) contributes
   0 where the monthly total subtracts it.
3. **Burn has no lump rule, unlike `projectSpend`.** Quarterly tax (Apr 8 587 + Jul 8 424) becomes
   4 253/mo forever; one 5 000 dentist visit becomes 1 795/mo of «Здоровʼя».
4. **Timing:** §LEVEL-WINDOW landed the same day and moved the denominator from 6 to 4 (the ledger
   opens 7 Apr), lifting EVERY level ~1.5×. Yesterday burn would have read ≈30k. The complaint's
   timing is exact.

§LEVEL-WINDOW itself is right; it exposed what was hidden. Planned:
- (a) a test pinning `|sumLevels − mean of full months| ≤ 10%` — it would have failed today;
- (b) `fixed` divides by covered months too, so the sum reconciles by construction;
- (c) lumps leave burn into their own field (§SUB-MONTH's split, applied to spending);
- (d) re-propose the envelopes afterwards — «Комуналка» is limited at 1 087 against a real 1 660.

---

## C. Browsing statistics by month

The server ALREADY takes explicit `from`/`to`/`bucket` on `/analytics/overview` when no `preset` is
given, and every period-scoped block already passes `{from, to, currency}`. What is missing is a
month stepper in the `Stats.tsx` shell (`?ym=2026-07`). Blocks that are inherently about NOW —
health index, cashflow calendar, month forecast, patterns radar — must HIDE for a past month rather
than print today's figure under a July heading (§CAT-PAGE's rule).

A stacked-by-category monthly bar needs one new grouped query: `importanceByMonth` is literally the
right shape with `EFF_CAT_ID` in place of `EFF_IMPORTANCE`.

---

## Progress

| # | Item | State |
|---|------|-------|
| 1 | A1 — 404 on linked charge | **done** |
| 2 | A2 — "no charges" above the charges | **done** |
| 3 | A3 — `linkPlanHistory` on create/edit | **done** |
| 4 | A4 — detection by core token + amount bucket + rhythm | **done** |
| — | `subscriptions.ts` split under C3 → `plan-match.ts` (the DB half) | **done** |
| — | `recurring.test.ts` (9) + `plan-link.test.ts` (8); suite 756 → 773 | **done** |
| 5 | B — burn reconciliation test (`burn.test.ts`) | **done** |
| 6 | B — `fixed` denominator | **hypothesis WRONG, see below** |
| 7 | B — the recurring/lumpy split (§BURN-SHAPE) | **done** |
| 8 | C — month stepper (§MONTH-VIEW) | **done** |
| 9 | C — stacked category bar (§MONTH-STACK) | **done** |
| 10 | enrich `recurring_guess` (§AI-RECURRING) | **done** |
| 11 | daily AI pass over candidates | **not built — see below** |
| 12 | unreachable envelopes named (§BUDGET-REACH) | **done** |
| 13 | stale level in a category gone quiet | open question |
| 14 | on-screen statistics audit (§HEALTH-INCOME) | **done** |


## Delivered 2026-08-27 — section A

- `src/pages/Subscription.tsx` — `/tx/${id}`; three chart states (`sub.oneChargeTitle/Hint`).
- `worker/lib/finance/plan-match.ts` — NEW. The DB half of subscriptions, split out of
  `subscriptions.ts` under lint C3 (which fired, and got a seam rather than a raised cap).
  Holds `linkPlanHistory` / `linkPlanHistoryById`; `activeSubs` no longer demands a category.
- `worker/lib/finance/recurring.ts` — NEW. `recurringCandidates`: core token, ±10% amount bucket,
  median-gap rhythm, and `BUCKET_DOMINANCE` — the rule the first draft was missing, without which
  «Сільпо» came back as three subscriptions.
- `worker/repo/planning.ts` — `detectCandidates` → `detectCharges` (raw rows); `declaredPlans`.
- `worker/lib/finance/categorize.ts` — a category-less plan links and lets the chain continue.
- `worker/routes/api/planned.ts` — POST and PATCH link history and return `linked`.
- `src/store/api.ts` — both mutations invalidate `Tx` as well as `Planned`.
- `src/pages/Subscriptions.tsx` — the toast says how many charges were found.
- Goldens re-recorded: `planned.detect` (five shop proposals → one real one) and four `writes`
  files (the `linked` field only — no database state moved).

`npm run check` green: 773 tests (was 756), every lint C1–C10 clean. `npm run build` green.
Not deployed — that is the owner's routine.


## Correction to section B — measured, 2026-08-27

Two of the four causes listed above were WRONG, and the measurement is recorded here so they are
not proposed a third time. Per-category, per-month figures pulled through MCP:

| category | Apr | May | Jun | Jul | mean | level | why |
|---|---|---|---|---|---|---|---|
| Дім і побут, оренда | 442 | 12 500 | 13 515 | 12 600 | 9 764 | **12 872** | `fixed` — April had NO rent charge at all |
| Відсотки по кредиту | 0 | 1 676 | 1 639 | 1 666 | 1 245 | **1 660** | `fixed` — the credit began in May |
| Продукти | 5 651 | 6 204 | 6 014 | 5 488 | 5 839 | 5 902 | noise |

Sum of plain means, all categories: **40 815**; plus the `fixed` branch **+3 586**; plus the
confirmed metro fact **+383** → **44 784**, which reconciles exactly with the reported burn, and
40 938 reconciles exactly with the mean of the four full months.

- **(1) "the `fixed` branch drops zero months from its denominator" — NOT a defect.** That is the
  whole +3 586, and it is right: it prices rent at what he pays NOW. The mean would price it at
  9 764, a figure that describes no month and no future.
- **(2) "the per-category floor of 0 breaks the offset" — no measurable effect** on this ledger.
- **(3) LUMPS — this was the real one.** Quarterly tax 4 253/mo forever, one dentist visit
  becoming «Здоровʼя 1 795/міс», an April electronics spree still charged to every future month at
  3 507/mo after the category went quiet. Total **16 077**, i.e. 36% of the burn.
- **(4) §LEVEL-WINDOW's timing** explains why the number JUMPED that day (denominator 6 → 4), but
  the level it produced is the correct one.

Delivered: `burnShape()` in `levels.ts` (`MonthLevel.lumpy`, two tests measured off this data),
the split in the snapshot with a note telling the model these are PARTS of the burn, `burn_recurring`
/ `burn_lumpy` on `Advice`, a sub-line under the burn figure on the Advisor card, and
`worker/test/burn.test.ts` (5 scenarios) including the reconciliation invariant nobody had.

## Delivered 2026-08-27 — section C

- `worker/repo/analytics.ts` — `categoryByMonth`, deliberately the same shape as `importanceByMonth`.
- `worker/lib/finance/history.ts` — top-8 + "other" fold, ranked over the WHOLE window.
- `src/pages/Stats.tsx` — `?ym=`, the month stepper replacing the range picker, the now-only
  blocks hidden with a line saying why.
- `src/components/stats/MonthStack.tsx` — the stacked bar; click opens that month.
- `src/styles/advisor.css` — NEW (C8 ratchet fired on `domains-a.css` again).
- `worker/lib/ai/budget.ts` — NEW (C3 ratchet fired on `advisor.ts`; one-way import, no cycle).
  It also removed a SECOND declaration of `BudgetProposalRow`/`BudgetPlanResult` that had been
  shadowing the `shared/api/` contract.

`npm run check` green: 779 tests (was 773), every lint clean. `npm run build` green.


## Delivered 2026-08-27 — from live use (screenshot report)

**«кожні ~41 дн» about a plan billed on the 6th.** Verified against the ledger through MCP: five
Apple charges, all on the 6th (Apr–Aug), and the page counted FOUR — the July row is not linked to
the plan. `(last − first) / (n − 1)` over Apr 6 → Aug 6 with three gaps is 40.7. Two defects, one
symptom:
- the page computed its own pacing, and a mean dies on one gap → `chargeRhythm` (§RHYTHM), the
  median gap, shared with §SUB-DETECT. Gaps 30/31/61 → 31.
- it had no way to say the better answer: it bills on the **6th**. That is what the owner used to
  spot the bug, and it is now what the card leads with — so a fixed-day plan no longer gets a
  drift warning for the calendar being what it is.
- the hole is reported (`skipped_gaps`) and has a button (`POST /planned/:id/relink`).

**The dashed "declared" line was invisible.** `Math.round(period_amount / 100)` threw away exactly
the difference the line exists to show (43.56 vs 44.00 → both 44), so it landed on the bar tops —
while the card beside it read «на 1% дорожче за план». Fixed: unrounded, labelled, coloured, and
the Y domain now carries 18% headroom (with Recharts' default the axis max IS the data max, so a
line there has no pixels).

**New statistic on that page:** §PRICE-STEPS — every price level the plan has been billed at, with
the date it started and how many charges it covered. "Has it got more expensive" was one
comparison against today; this answers *when*.

**§BUDGET-REACH** — an envelope whose limit sits below the level the app itself computes now says
so. «Комуналка» at 1 087 against 1 246/1 285/2 531/1 458 has reported «153% перевищено» every
month for a target arithmetic cannot meet. Named, never auto-corrected.

Also removed a THIRD duplicated contract type (`BudgetStatus` in `lib/finance/budgets.ts` shadowing
`BudgetStatusRow` in `shared/api/`) — `tsc` caught the drift only at the route, one layer out from
where it was.

`npm run check` green: 786 tests (was 779), every lint clean. `npm run build` green.


## Delivered 2026-08-27 — the on-screen audit, and the AI tails

**The audit method.** The blocks MCP cannot reach were checked not against a recorded number but
against the OTHER block that describes the same money — a reader who sees two screens disagree has
no way to tell which is lying, and that is the failure this project keeps paying for. Now pinned in
`consistency.test.ts`: forecast month-to-date = the month preset (spend AND income); an explicit
`from/to` window = the preset covering it (§MONTH-VIEW rests on this); the cashflow calendar = the
"upcoming charges" widget; a projection never below what is already spent; the health score in range.

**Found: §HEALTH-INCOME.** `GROUP BY month` returns no row for a month with no income, and the code
filtered `> 0` on top — so the average income AND the stability score (15% of the index) were taken
over the months that happened to have income. **A jobless month made income look more stable.** Same
class as §LEVEL-WINDOW, mirrored. The fixture pays a salary every month, so no golden moved and
nothing caught it; the new test builds two accounts (income in 6 of 6 vs 3 of 6) and requires the
second to score lower — on the old code both scored a perfect 100.

`coveredMonths` came out of `levels.ts` as the single answer to "which months does this account
have", and the fourth spelling of the savings ratio was replaced with the canon.

**§AI-RECURRING (migration 0046).** Enrich already looks at the operation, so one extra field
(~$0.02/mo) means a subscription can be proposed on the day of the FIRST charge — the one moment
the person still remembers signing up, and two months before a rhythm can exist. Three states
(NULL = never asked), the guess rides behind the measurement and never replaces it, and it is
badged as a guess on screen.

**The daily AI pass: not built, deliberately, and it is the owner's call.** After §SUB-DETECT
(rhythm + price dominance) and §AI-RECURRING (first-charge guess), both ends of the question are
covered — "has a rhythm" and "just appeared". A third mechanism answering the same question is the
shape §CUR-PLAN is named after, and this one would be paid and daily. If noise in the "detected"
block survives in practice, the right build is a review pass over THAT list, not a parallel detector.

**Ratchets, three of them, all given seams:** `lib/finance/health.ts` (out of `advisor.ts`),
`lib/ai/transfers-ai.ts` (out of `enrich.ts`, along the divider that file had already drawn) — after
which **`enrich.ts` lost its exception entirely** and lives under the plain 400-line cap for the
first time since spring.

`npm run check` green: 793 tests (was 786), every lint clean. `npm run build` green.
⚠️ **Migration 0046 must be applied before deploy** — enrich writes `ai_recurring` on every
operation, so without it enrichment fails on the first webhook.


## §HEALTH verified on live figures — 2026-08-27

**Cadence:** computed LIVE on every `GET /analytics/health`. No cron, no server cache. One row per
KYIV day in `health_history` (upsert), and those rows are what `draftHealthDrop` compares. Named
consequence: the history has holes for days the app was not opened, so "dropped over the week" is
measured on a sparse series. Deliberate — the score cannot be reconstructed retrospectively
(historical funds and levels are gone) — not a defect.

**Recomputed by hand against the owner's ledger** (cushion 41 190, debt 77 963, burn 44 784,
income Apr–Jul 57 911 / 33 902 / 25 893 / 37 543):

| component | figure | score | weight |
|---|---|---|---|
| runway | 41 190 / 44 784 = 0.92 mo | 15 | 0.35 |
| savings | −5% (was −15%, see below) | 0 | 0.30 |
| debt | 77 963 / 38 812 = 2.0× income | 33 | 0.20 |
| stability | cv 0.30 → 70% | 70 | 0.15 |

≈ 22/100, band `risk` — which matches the situation.

**Three defects found and fixed:**
1. **The savings ratio mixed bases** — `(avgIncome − burn) / avgIncome`, a canonical LEVEL against a
   raw mean. Displayed −15% where actual-against-actual is −5%, under the same name the Trends strip
   uses for the canonical rate. Now both sides are actuals over the same covered months.
2. **Stability could display a negative percentage.** `1 − cv` is unbounded; the spiky-income shape
   (five empty months, one payment) gives cv ≈ 2.2 → «-124%». Reachable only because §HEALTH-INCOME
   started counting the empty months — the fix that made the figure honest exposed the display, and
   it would have shipped to exactly the people whose income is least stable. Now the card shows the
   clamped score itself: one number, not two readings of it.
3. **Stale cache.** `providesTags: ["Advice"]` — not one of its inputs. The score is built from
   account balances and transactions, so a new operation left the Dashboard badge on the previous
   answer while the page stayed mounted. Now `["Tx", "Account", "Advice"]`.

`npm run check` green: 795 tests, every lint clean. `npm run build` green.


## UI pass from the owner's screenshots — 2026-08-27

- **§BUDGET-REACH sentence was broken.** `t("eg.unreachable", { level: "" })` interpolated an EMPTY
  `{level}` and appended the amount after, so it rendered «звичайні витрати () — ціль недосяжна»
  with the figure orphaned on the next line. One sentence now, with the number inside it.
  ⚠️ The FIGURES were right: «Комуналка» real months 1 246 / 1 285 / 2 531 / 1 458 → level 1 630,
  limit 1 087, and 1 630 > 1 087 × 1.15, so the flag is correct. Only the sentence was wrong.
- **`51.919999999999995` on the charge-history axis** — my own `max × 1.18`. Recharts prints the
  domain bound as a tick verbatim, so a raw float landed on an axis where every other number is a
  price. Rounded up to a readable step (44 → 52, 1 070 → 1 300).
- **Sparkline clipped its last point, everywhere.** `stepX = width / (n − 1)` puts the final point
  at exactly `x = width`, so half the stroke and half the end dot fell outside the viewBox — and
  `preserveAspectRatio="none"` stretched the clip with the box. The x range is inset by `pad` now,
  like the y range always was. This was in the shared component, so every sparkline in the app.
- **«Схоже на підписки» cards clipped and truncated the merchant** («ГУ ДПС у Су…»). Reworked to
  two rows — identity above, amount and actions below — the name WRAPS instead of being cut, and
  the dismiss ✕ moved to the card corner rather than taking a fourth column at 260px.
- **The month browser had no way in.** §MONTH-VIEW shipped reachable only by typing `?ym=` or by
  finding a bar to click on another tab. A «Місяці» button now sits beside the period controls and
  opens the last complete month; the ‹ › stepper takes over from there.
- **`text-wrap: balance`** on short blocks (empty states, hints, subtitles, headings) and `pretty`
  on prose — a single-word orphan reads as a layout fault, and every hint in the app is that length.
