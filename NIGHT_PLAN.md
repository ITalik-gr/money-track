# NIGHT_PLAN — autonomous overnight run

> Temporary working document for ONE overnight session. Delete it in the morning; anything durable
> moves to `ROADMAP.md` (queue), `CLAUDE.md` / `docs/CANON.md` (invariants), `DESIGN.md` (UI log),
> `HISTORY.md` (the morning report).
>
> Baseline at start: `npm run check` green (exit 0), working tree clean, `finance` 0054,
> `directory` 0011, lints C1–C15.

## Standing rules for the night

1. **Green bar per batch, not per night.** Every batch ends with `npm run check` + `npm run build`.
   A red bar is fixed before the next batch starts; if it cannot be fixed, the batch is reverted
   from a scratchpad copy (never `git checkout`) and written up as blocked.
2. **Never commit.** The owner commits. Work stays in the tree.
3. **A check beats an instruction.** Anything proven by hand tonight gets a deterministic check.
4. **English for everything newly written.** Chat replies to the owner stay Ukrainian.
5. **No live checks, no deploy, no paid `npm run eval`** (`-- --dry` only). No secret rotation.
6. **Log as you go.** Each finished task: strike it here with a one-line result, and append a line
   to `HISTORY.md`. That file is the morning report.
7. `graphify query` first for orientation; `graphify update .` after a batch that moved code.
8. If a task turns out to need the owner's eye, a live key, or a canon decision — stop it, write
   why under **Blocked** at the bottom, and take the next task. Never idle.

---

## Batch A — the self-contained cards already in the queue

### A1. SQLite `LOWER() LIKE` with Cyrillic — the two remaining sites
**Goal:** no worker SQL decides a Cyrillic match with `LOWER(x) LIKE`, and a lint keeps it that way.
**Files:** `worker/lib/ai/enrich.ts` (`consensusCategory`), `worker/repo/transactions.ts:~888`,
`scripts/check-sql-lower-like.mjs` (new), `package.json`.
**Steps:** copy the `linkPlanHistory` shape (script-free filter in SQL, name matched in JS) → both
sites → new lint **C16** flagging `LOWER(` in the same SQL string as `LIKE` inside `worker/**` →
a test with a merchant named «Київстар» that fails on the old code.
**Done-when:** the Cyrillic test fails on a stashed copy of the old query and passes on the new one;
C16 is in `npm run check`.

### A2. Jev held-out cases — widen the evidence BEFORE any line moves
**Goal:** the §SUB-REVIEW lines (0.5 / 0.4) rest on more than 20 merchants.
**Files:** `worker/test/__eval__/sites.json`, `scripts/eval-sites.mjs`.
**Steps:** add held-out cases written tonight, from shapes the current set does not cover
(Cyrillic merchant names, one-off large purchases that look like subscriptions, annual billing,
trial→paid, refunds) → **do not move any threshold** → run `node scripts/eval-sites.mjs --dry`
where it is free, otherwise only record what would be measured.
**Done-when:** the case count grows, every new case carries its expected verdict and why, and
`judge-sites.test.ts` still passes. §JEV-EVAL holds: cases were written before the code moves.

### A3. Batch runs — `enrichPending` as a real job kind
**Goal:** §A6-BATCH stops being pinned on `noop_batch` alone.
**Files:** `worker/services/jobs*`, `worker/lib/ai/enrich.ts`, `shared/notif-i18n.ts`,
`worker/lib/messaging/notify.ts`, `worker/test/job-batch.test.ts`.
**Steps:** own job kind + `NotifKind` + template + label (i18n parity both locales) → progress
strictly growing or the run stops → tests with a faked provider, since the paid payload needs the
owner's live key.
**Done-when:** the fake-provider test drives the batch to completion and to a stall, and the
notification renders in uk and en. The live paid run stays the owner's, written up as such.

---

## Batch B — the risky ones (owner approved «maximum, including risky»)

### B1. STYLES phase 0.5 — the 8 silently conflicting selectors
**Goal:** the unwritten merge becomes written, with no unapproved visual change.
**Files:** `src/styles/*`, `src/index.css`, `DESIGN.md §8`.
**Steps:** for each of the 8, write down the computed winner today (property by property) → collapse
into one rule that produces exactly that → record each in the `DESIGN.md` decision log → C9/C11/C15
green.
**Done-when:** the 8 are gone from the conflict list and the written rule reproduces the old
computed value for every property. **Anything where the merge is ambiguous is left alone and listed
for the owner's eye** — a guess here is a silent redesign.

### B2. The 13 modifier classes that do nothing
**Goal:** `STYLELESS_OK` shrinks.
**Files:** `scripts/check-styles-used.mjs`, the components that emit each class, `src/styles/*`.
**Steps:** per class decide from the component, not from the name: leftover → delete the class from
the markup; unfinished intent → either finish it in `src/styles/*` or leave it in the list with a
one-line reason.
**Done-when:** the list is strictly shorter, every remaining entry has a reason next to it, and no
entry was added.

---

## Batch O — the owner's notes (highest priority: they come from a live eye)

> These were written by the owner while looking at the running app. That makes them the scarcest
> input in this file — everything else I can derive from the code, this I cannot. `DESIGN.md`
> before any of the UI ones; every decision here gets a line in its decision log.

### O1. The health index — is the formula even right, and can it be read?
Three separate things, in this order:
1. **Audit the formula before touching the chart.** `health.ts` is four weighted components
   (runway · savings · debt · stability) and it already carries two scars — §HEALTH-INCOME
   (zero-filled income, because a jobless month used to make income look *more* stable) and the
   savings ratio that once mixed a canonical level with a raw average and displayed −15% where
   actual-against-actual was −5%. So the question «чи працює вона» is fair and gets a real answer:
   re-derive each component by hand on the fixture ledger, check the four contributions actually
   sum to the score shown above them, check the band cuts (70 / 45), and check every component
   degrades sanely at the edges — no ledger, no income, no debt, a runway over 12 months.
   Anything that disagrees is either a bug (fix it, with the fixture that caught it) or a
   deliberate threshold (then write WHY next to it). **A number that grades a person's life may
   not be approximately right.**
2. **The trend chart has no hover.** `FinanceHealth.trend` exists and is drawn, and there is no way
   to ask it what the score was on a given day. Add the tooltip: the date, the score, the band, and
   — this is the point — **which component moved**, because «68» on its own teaches nothing.
   Follow `DESIGN.md` for chart and tooltip form; both themes are equals.
3. **The AI does not know the score.** It should: the index is the app's own one-line verdict on
   the owner's position, and the advisor currently reasons without it. Add it to
   `collectFinanceSnapshot` (financial context comes from there ALONE, so chat = advisor = screens)
   with its components and its direction over time. Watch: it is a number shown to a person, so it
   passes `numbersAreGrounded`; the model may explain and weigh it, never recompute or restate it
   with a different value.

### O2. Percentages next to the hryvnia, everywhere a composition is shown
«З чого складається місяць», categories, breakdowns — they almost always show only the amount. A
part without its share of the whole is the one number that cannot be compared to anything.
**Goal:** every composition surface shows both: amount and % of that view's total.
**Files:** `src/components/stats/*` (`MonthStack`, `SpendDonut`, `StatsCategories`,
`CategoryShape`, `IncomeBreakdown`, `SpendProfile`…), `src/pages/Category.tsx`.
**Watch:** the percentage is of THIS view's total and says so — a share whose denominator is
invisible invites the wrong comparison. Rounding must not produce a set that sums to 101%; pick one
rule and pin it in a test. Do not put a % on a figure that has no meaningful whole (net worth,
runway). `baseSign()` for the money half, never a literal ₴ (C10).

### O3. The cashflow calendar — redesign, and the popup that gets cut off
**The bug first:** hovering a day opens a mini popup that is **clipped when it would extend past
the calendar's bounds** — so the days at the edges, which are exactly the ones a person checks at
the end of a month, are the ones that cannot be read. Fix it properly: the popup escapes its
container and flips against the viewport edge rather than being clamped inside a grid cell. Check
it at ~400px width too, and with the keyboard, not only the mouse.
**Then the redesign:** `CashflowCalendar` predates the current design language — bring it to it
(`DESIGN.md`: tokens only, no local hardcoded colour or shadow, no `transition: all`, both themes
equal, touch targets). Keep what the calendar KNOWS — it is the only screen where planned charges,
real ones and the cushion line meet on the same dates — and change only how it says it.
**Done-when:** the popup is legible on every cell including the corners, C9/C11/C15 green, and the
visual change is recorded in the `DESIGN.md` log. Anything ambiguous → the owner's list, not a guess.

### O4. Reports — make them actually informative
**Goal:** re-read `src/pages/Reports.tsx` and the weekly/monthly report drafters end to end and ask
of every line: does this tell the owner something he did not already know from the dashboard? A
report that restates the dashboard in sentences is a notification tax.
**Direction (to be judged against the real output, not assumed):** lead with what CHANGED and what
is unusual for this person, not with totals; name the cause when the data names it (which merchant,
which category, which one-off); carry a comparison in every figure (vs last period, vs this
person's own level); end with what is coming, not with what is gone. The new statistics from batch
S are the natural filling — committed share, concentration, income rhythm — and the health index
from O1 is the natural opening line.
**Watch:** §AI-FEED / §NOVELTY — repetition is cured by an explicit list of what was already said,
so a better report must not become a wordier one. Every number grounded (`numbersAreGrounded`),
every date given (§TIME-CTX). uk + en parity.

### O5. Category and Subscription pages — level them up (owner likes the idea of both)
The owner names these two as the pages whose IDEA is right and whose depth is thin.
**Category page** (`src/pages/Category.tsx`, `category-drill.ts`, `category-shape.ts`): make it
answer «що це за категорія в моєму житті» — the level and whether this month is above or below it,
the share of the month (O2), who the money actually goes to (the merchant set and its concentration
from S2), the rhythm (weekday / day-of-month profile that already exists), what is planned inside
it, price drift for the repeating items, and the drill-down that is already built. Plus **the
settings that belong to it, right there**: budget, importance, business flag — editing a category
should not mean going to look for it.
**Subscription page** (`src/pages/Subscription.tsx`): the F1 work lands here — state (due / late /
changed / missing), price history with every step, the annual cost, what cancelling frees, the
linked charges with what matched them and what did not — plus its own settings inline: period,
amount, category, note, pause, alias (§SUB-ALIAS).
**Watch:** `Select`, not native `<select>`. `src/components/ui/` has no queries. C3 ceilings —
both pages are already large, so this is extraction work as much as addition. An inline setting
writes on an explicit action, never on blur-by-accident, and an AI proposal is only offered — a
person's click writes the real column.

---

## Batch S — four new statistics

> Canon first, every time: `docs/CANON.md` before any number. Each one goes through
> `worker/lib/finance/stats.ts` and neighbours, is declared once in `shared/api/analytics.ts`,
> answers in the reader's currency (`baseSign()`, §BASE-CUR), uses the Kyiv calendar (§APP_TZ),
> and gets a golden (C5). **No second definition of a number that already exists** — each card
> below names the helper it composes, and composing is the whole point: nothing here recomputes
> burn, levels or the floor.

### S1. Committed share of income — how much of the month is already spoken for
**Goal:** one figure with a trend: what share of a typical month's income is committed before any
decision is made — the recurring floor (`burnShape(levels).recurring`, §FLOOR) + planned charges
(`sumMonthlyPlannedUAH`) + the tax accrual (§TAX-RESERVE) — and what is left free.
**Why it is worth a card:** `floor.ts` already says the app knows what it costs this person to
exist, but the number is only ever shown against the cushion. Against INCOME it answers a different
question: «скільки в мене свободи», and its trend answers «чи вона звужується».
**Watch:** the tax reserve reduces free money only, never cushion or runway (§TAX-RESERVE), and the
ФОП half is owner-gated (§FOP-GATE) — with the module off the card must not produce a confident
zero (§BIZ-SPLIT). Double counting is the real risk: a subscription that is already inside the
recurring floor must not be added again — the card subtracts the overlap and the test pins it.

### S2. ~~Merchant concentration~~ → §PAYDAY-EFFECT: how fast money goes once it lands
> **Replaced 2026-09-25.** Reading `docs/CANON.md` showed the original S2 already exists:
> §SPEND-PROFILE returns `merchants_for_half`, `top5_share` and `new_faces`. Building it again would
> be the second definition this repo lints against.

**Goal:** after a meaningful income receipt, how much faster does discretionary money leave in the
next 7 days than in an ordinary week — «після надходження ти витрачаєш у 1.6× швидше».
**Why it is new:** nothing measures spending RELATIVE TO income arrival. It is behavioural, it is
the thing budgets usually miss, and it works for irregular (ФОП) income, because it is anchored on
real receipts rather than on a detected payday (`detectPaydays` needs a fixed day of month).
**Definition:** receipts = canonical income (`INCOME_WHERE`) ≥ 25% of the §FLOW-SERIES typical
month, receipts within 3 days merged into one event; «discretionary» = canonical spend that is not
plan-linked and not `essential` (a rent paid on payday is a bill, not a behaviour); baseline = the
same population's spend per 7 days across the window; ratio needs ≥ 3 events (a sample, §CADENCE's
spirit) or it is null.
**Done-when:** endpoint + shape + tests (a ledger built to CONTAIN the effect, and one that does
not), swept for §BASE-CUR, a small card; null answers render as silence.

### S3. Income stability — lumpiness, gaps, floor coverage
**Goal:** for someone whose income arrives in irregular chunks: the longest gap between receipts,
the spread of the amounts, and in how many of the last N months income covered the floor.
**Why:** `incomeOutlook` forecasts the amount; nothing describes the RHYTHM. For a ФОП that rhythm
is the actual risk — a good annual total with a two-month hole is a different life from an even
one, and the app currently cannot tell them apart.
**Watch:** foreign income is frozen at the NBU rate on the credit date (§TAX-FX) — the stability
figures must use the same frozen values, never today's rate, or the past changes shape each morning.
Transfers between own accounts are not income (`transfers.ts`).

### S4. Currency exposure and FX sensitivity
**Goal:** what share of assets, and what share of spending, sits in each currency; and what a ±10%
move does to net worth — computed from `networth.ts` and `rate_history`, not invented.
**Why:** `FxCost` answers what conversion COST, which is backward-looking. Exposure is the forward
question, and for a multi-currency ledger it is the one that moves the biggest number on the screen.
**Watch:** ±10% is a sensitivity, not a forecast, and must be worded as one — a modelled number that
reads as a prediction is exactly what §TIME-CTX and `numbersAreGrounded` exist to prevent. The
answer currency is the reader's, so the scenario is stated relative to it.

**Done-when (all four):** each has a golden (C5), a shape in `shared/api/analytics.ts` that the
worker `satisfies`, uk + en strings, a card that survives an empty ledger without lying, and an
error branch (a page with `data?.x ?? []` must have one). Anything that needs a live screen to
judge — placement, chart form — is written up for the owner, not guessed.

---

## Batch F — two features taken up a level

### F1. Subscriptions — the night's flagship (owner: «lvl up ще вище»)
**Today:** the plan math is solid (`nextChargeUnix`, `monthlyPlannedUAH`, `subscription-overview`,
`price-drift`, §SUB-ALIAS / §PLAN-LINK matching in `plan-match.ts`, the §SUB-REVIEW judgment). What
is missing is everything ABOVE the individual row — and one live bug proves it.

#### F1.0 — THE BUG, first, before any new surface (owner's YouTube, real data)
YouTube was 100 ₴ and is now 179 ₴. The charge arrived, with the same merchant and the same date
shape, and **the app did not link it to the plan**. Worse, the subscription card still says the
next charge is 24 October: it never noticed that this month's charge already happened, so it shows
a confident future for a plan whose present it missed.
**The two defects are separate and both are ours:**
- **Matching is too strict about the amount.** `plan-match.ts` matches on name (§SUB-ALIAS) but the
  amount is part of the gate. A subscription's price changing is the single most ordinary thing a
  subscription does; it must not break identity. Fix: when name + cadence + date window agree, a
  differing amount **still matches**, and the difference is REPORTED, not swallowed — «Ціна
  змінилась: 100 → 179 (+79%)», with the plan's `period_amount` updated only by a person's click
  or by a rule we can defend. A near-match must never silently rewrite money.
- **A plan has no state.** «Next charge» is arithmetic on the start date; it never asks whether the
  PREVIOUS one landed. Give the plan an honest state machine over the charges already stored:
  `due` · `paid` · `late` · `changed` (amount differs) · `missing` (window passed, nothing found) ·
  `ended` (nothing for N cycles). §PLAN-LATE holds: a scheduled payment is news only 3 days AFTER
  its date, and «not linked» ≠ «not paid» — so `late` is a question the card asks, never an
  accusation, and the card must be able to say «щось сталося з цією підпискою» instead of a
  serenely wrong future date.
**Done-when:** a fixture reproducing exactly this case (same name, same date, 100 → 179) fails on
today's code and passes after; the card shows the change and the state; nothing auto-edits an
amount; §PLAN-LATE timing is pinned by test.

#### F1.1 — the stack, not the list
1. **Price history per subscription** — every change with its date and its size, from the charges
   already stored. A subscription that went up 40% over a year should say so in one line, and
   F1.0's detection is what feeds it.
2. **Trial → paid** — a small or zero first charge, then a step up on the next cycle; pinned with
   fixtures rather than asked of a model.
3. **Duplicates and neighbours** — two live subscriptions of the same kind, surfaced as a question.
4. **«What cancelling frees»** — this subscription's annual cost and what dropping it does to the
   committed share from S1. Clearly labelled as a simulation; it changes nothing until a person acts.
5. **The stack's annual total and its drift** — what the whole set costs per year, and how that
   number moved over the last 12 months. A stack that grew 30% while every single row looked small
   is the thing nobody notices.
6. **Cadence honesty** — annual plans shown at their monthly weight AND their real billing date, so
   a yearly charge stops ambushing a month.
**Watch:** the amount never comes from a model; Jev/Claude judge whether something IS a subscription
(§SUB-REVIEW), not what it costs. §SUBS-CAT: the «Підписки» category is retired, so the stack is
defined by plans, not by a category. A paused, ended or cancelled plan must not keep counting into
S1. `Subscriptions.tsx` (620 lines) and `Subscription.tsx` stay within the C3 ceiling — extract,
never raise.
**Done-when:** every item above has fixtures and a test, `npm run check` + `npm run build` green,
and the subscription card can be read without opening the ledger to check whether it is telling the
truth.

### F2. Search: a query people actually type
**Today:** `search()` filters in SQL, `hybridSearch`/`appendSemantic` add vectors when they are
switched on (off by default, §SEARCH-VEC), and the UI has a filter panel. Typing what you mean into
one box does almost nothing.
**Goal:** a deterministic query parser — `worker/lib/finance/query-parse.ts` — that turns free text
into the filters that already exist, before any vector is touched:
- amounts and ranges («понад 500», «200–400», «>1000»),
- periods in both languages («у травні», «last week», «за минулий квартал») through `time.ts`,
  never `new Date(x).getMonth()` (§APP_TZ, C12),
- category / merchant / account by name, with Cyrillic case folded in JS, not in SQL (see A1),
- exclusions («кава без Starbucks»), and income vs spending.
The parsed filters are SHOWN as removable chips, so the person sees what the box understood and can
correct it. Whatever the parser does not claim stays free text and goes down the existing path.
**Why this is the level-up:** it is the same jump the filter panel gave, but without the panel, and
it lands twice — the MCP `find_transactions` tool gets the same parser, so the second assistant
stops guessing filter names.
**Watch:** the parser is a parser — it must never widen a result silently. An unrecognised token is
never dropped; a query that parses to nothing falls back to text search and says so. No SQL leaves
`repo/*` (C1).
**Done-when:** a table-driven test covers both languages including the ambiguous cases, the chips
render the parse, `find_transactions` uses it, and `financeReadTools()` still reports read-only.

---

## Batch C — my own additions (beyond the queue)

### C1. File-size pressure, before the ceilings do it loudly
`src/store/api.ts` 1342 · `worker/repo/analytics.ts` 993 · `worker/repo/transactions.ts` 897.
**Goal:** each splits along a real domain seam, not an arbitrary cut; C3 exceptions only shrink.
**Done-when:** no behaviour change (goldens C5/C6 untouched and green), and the C3 exception list
has smaller numbers than tonight.

### C2. The error branch a page forgets
CLAUDE.md already says it: a page with `data?.x ?? []` must have an error branch. It is an
instruction, so it should be a check.
**Goal:** new lint **C17** — a component that renders `?? []` from a query result must also
reference `<ErrorNote>` or an `isError` branch; the offenders it finds get their branch.
**Done-when:** C17 is in `npm run check` and its offender list is empty.

### C3. Structured outputs instead of `repairTruncatedJson`
An AI 4.0 tail, self-contained at the `worker/lib/ai/json.ts` seam.
**Goal:** `output_config.format` carries the schema; `repairTruncatedJson` stays as the fallback
path, not the primary one. Truncation at `max_tokens` remains an ERROR even if JSON parsed.
**Done-when:** the seam chooses structured output when the provider supports it, the old path is
covered by its tests, and nothing outside `json.ts` learned about the change.

### C4. One-shot provider adapter (seam only, no second provider)
**Goal:** `json.ts` exposes a one-shot adapter interface so a future provider is a file, not a
refactor. Agentic chat stays on Anthropic, untouched. `demoClamp`'s Anthropic-only knowledge gets
an explicit guard instead of an assumption.
**Done-when:** Anthropic is the only implementation and every existing AI test passes unchanged.

### C5. Accessibility pass on the client, then a check
**Goal:** keyboard reachability, visible focus, touch targets, contrast — in BOTH themes, which are
equals.
**Done-when:** findings fixed where mechanical, and the mechanical part (focus-visible present,
no `outline: none` without a replacement, no interactive `<div>` without a role and a key handler)
becomes a lint. Anything needing a live screen goes to the owner's list.

### C6. i18n sweep
**Goal:** no dead keys, no runtime-built key missing from `DYNAMIC_KEYS` (§I18N-DYNKEY), uk/en
parity beyond key names — both actually worded.
**Done-when:** the sweep is a script, it is green, and it is in `npm run check`.

### C7. Dead export sweep
**Goal:** an export nobody imports is either used or gone.
**Done-when:** `scripts/check-dead-exports.mjs` exists with an explicit allowlist (public entry
points, `shared/api/*` shapes), is green, and the deletions it forced are listed here.

### C8. Tests for the error paths themselves
`app.onError` shape `{error, detail}`, `numParam()` on garbage, `errText(e)` on every shape of
thrown thing, the owner-only raw cause on a 500.
**Done-when:** `bad-input.test.ts` grows to cover them and the owner-only branch is pinned.

### C9. Bundle and route chunks
**Goal:** measure first (`vite build` output), then split the heaviest route chunks — Recharts is
the obvious suspect — and record before/after numbers here.
**Done-when:** numbers written down, PWA still builds, the service worker still has no
`navigateFallback`.

### C10. `§` index integrity
**Goal:** every `§XXX` mentioned anywhere in code, tests or docs is defined in `CLAUDE.md` or
`docs/CANON.md`, and every defined `§` is referenced somewhere.
**Done-when:** the script exists, is green, and is in `npm run check`.

---

## Order of work

**F1.0 (the YouTube bug) → O1 → A1 → S1 → F1.1 → O5 → O2 → O3 → O4 → S2 → S3 → S4 → F2 →
A2 → A3 → C2 → C10 → C6 → C7 → C8 → C1 → C3 → C4 → B2 → B1 → C5 → C9.**

Rationale:
- **F1.0 first.** It is the only item that is a wrong number on a live screen right now: a card
  stating a confident next charge for a plan whose last charge it missed. Everything else in this
  file adds; this one stops the app from lying.
- **O1 second** for the same reason — before the health index gets a tooltip and goes into the AI's
  context, the formula behind it has to be verified. Wiring a wrong score into the advisor spreads
  it to chat, reports and screens at once.
- **A1** (Cyrillic `LOWER() LIKE`) early because F1's matching and F2's parser both touch Cyrillic
  name matching, and doing it after them would mean editing the same lines twice.
- **S1 before F1.1**: F1.1's «what cancelling frees» reads the committed share S1 defines, and
  defining it twice is exactly the failure this repo lints for.
- **O5 after F1.1 and S1** — the two pages are where all of that work becomes visible; building the
  pages first would mean rebuilding them.
- Then the rest of the owner's notes, the remaining statistics, F2, the agreed queue cards, the
  cheap deterministic checks (they protect everything already written), the refactors, the two
  render-touching batches (B1/B2) late while there is still time to revert them cleanly, and the
  measuring ones last.

If everything above closes, do not invent code — spend what is left on: re-reading `docs/CANON.md`
against `worker/lib/finance/*` looking for a second definition of the same number, and on the
§REFUND-INCOME / limit-window / §CADENCE questions from the ФОП A1 audit as **written proposals with
tests, code behind a flag, nothing switched on** — each of those is a canon decision and canon
decisions are the owner's.

---

## Wake-up schedule

Filled in once the owner says when the 5-hour limit resets. Rule: wake a couple of times per reset
window, always **+5 minutes past** the reset so it has certainly applied.

Session started 2026-09-25 **01:57** EEST. The owner's 5-hour limit resets at **06:30**, so the
windows are 06:30–11:30 and 11:30–16:30. Two wakeups per window, always past the reset, never on it.

> Claude Code was restarted at 02:01 (model switched to Opus 5.5). The four cron jobs **survived**
> the resume (checked with CronList: `36b35e34`, `13613f46`, `aa2b621c`, `e29b3720`); the old
> `caffeinate` did not, and a new 12-hour one was started at 02:01 (runs until ~14:01). **If a
> future restart is a fresh session rather than a resume, check CronList first** — if it is empty,
> recreate both from the instructions below before taking any work item.

**1. Keep the machine awake** (12 hours, blocks display and system sleep):

```
caffeinate -dimsu -t 43200        # run in background
```

**2. Recreate the four wakeups** with CronCreate, one-shot (`recurring: false`), today
(day-of-month 25, month 9):

| When | Cron | Why that minute |
|---|---|---|
| 06:36 | `36 6 25 9 *` | +6 min past the reset — the window has certainly applied |
| 09:07 | `7 9 25 9 *` | mid-window, so a stalled batch does not cost the whole window |
| 11:37 | `37 11 25 9 *` | +7 min past the second reset |
| 13:47 | `47 13 25 9 *` | last one, inside the caffeinate window — writes the morning report |

Each carries the same instruction (Ukrainian, as the owner reads them): read this file — the
standing rules, the order of work and the progress log — take the next unclosed item, drive it to a
green `npm run check` + `npm run build`, log the result here and in `HISTORY.md`, commit nothing,
and put anything blocked under **Blocked** instead of idling. The 13:47 one additionally writes the
morning report.

If the restart happens LATER than these times, shift each to the next «+6 min past a reset» and keep
the same two-per-window shape: the resets run every 5 hours from 06:30 (06:30, 11:30, 16:30, 21:30).

---

## Progress log

_(appended as work lands; mirrored into `HISTORY.md`)_

### ✅ Canon sweep («second definition of the same number») — check + build green, 1169 tests

Two more found: the EVENT verdict gave the model «90 days ÷ 3» under the name `monthly_burn_uah`
(§AI-AVGNAME reserves that name for the canonical level) and a runway on NET funds; the BUDGET
planner used the canonical burn but also a NET-funds runway. With a credit-card debt both quoted a
shorter runway than every screen and the chat. Both now: burn = `sumLevels`, runway = liquid
cushion ÷ burn. Earlier the same night, same class: the report's own burn, a second `TRANSFER_CAT`,
a duplicated `PlannedActual`, a third income-stability CV.

### ✅ C9 DONE (route-level code splitting) — check + build green; runtime NOT smoke-tested

Measured first: there was NO route splitting — one 919 kB entry chunk (249 kB gzip) held all 25
pages, and since pages statically imported Recharts, the 399 kB `charts` chunk loaded up front too.
Every page is now `React.lazy` (`lazyPage` in `App.tsx`, typed so `tsc` proves each module exports
the named component), the dashboard included — so a logged-out visitor of the landing no longer
downloads a charting library. **Up-front JS: ~1689 kB → ~764 kB (−55%)**; entry 919 → 393 kB;
`charts` loads with the first page that draws a chart. The PWA precache holds all 70 chunks, so a
returning user gets pages from the service worker, not the network.
**Honest gap:** I could not smoke-test it in a browser — the Chrome extension was not connected,
and a headless Chrome rendered an empty `#root` for the HEAD version too (control experiment), so
that method proves nothing either way. **Owner, first thing after deploy:** open the app and click
through 3–4 pages; a blank page would mean a lazy import failed → revert the `lazyPage` block in
`src/App.tsx` (the eager imports are in git).
Not done: the i18n dictionaries (both languages) still sit in the entry chunk — loading only the
active one is the next size win.

### ✅ C5 DONE (mechanical part, lint C21) — check + build green

Focus: audited, and it is already right — a global `:focus-visible` ring, a restrained one for
fields, and the range slider's focus drawn on its thumb; every `outline: none` has a replacement.
Clickable non-buttons: 7 found; 5 are overlays/scrims (click-outside-to-close, not controls); **2
were controls a keyboard could not reach** — the conversation list in Chat (now role + tab stop +
Enter/Space + `aria-current`) and the ✕ on a sub-category chip (it sits inside the chip's button,
so the chip now takes Delete/Backspace, announced via `aria-keyshortcuts`; the ✕ is `aria-hidden`).
Lint C21 (`check-a11y-click.mjs`, full-tag scanner) keeps it; probed on the old files.
**Owner's eye:** contrast in both themes and touch-target sizes need a live screen.

### ✅ B1 DONE (phase 0.5) — rendered pixels proven unchanged — check + build green

«8 selectors that silently conflict» measured properly: **37 declarations** in 20 rules where a
property is set for a selector and set again, differently, by a later rule for the identical
selector — so the earlier value NEVER renders. 34 removed (the 3 left belong to selector LISTS,
where the declaration is still live for the other selectors). Proof, not belief: the effective value
of every property of every top-level selector across the whole `@import` cascade was computed before
and after — **0 differences**, every `@media` block byte-identical. Three rules emptied → deleted.
New lint **C20** keeps it that way (probed: flags exactly the 34 on the old CSS).
**Findings for the owner** (visual decisions, not touched): `.sub-ai-block` is neutral in explicit
dark but accent-tinted in system dark; `.wd-bar`'s transform animation was one of the dead
declarations, so the weekday bars do not animate the way DESIGN says bars animate. Both in ROADMAP.

### ✅ B2 DONE — `STYLELESS_OK` 13 → 0, zero render change — check + build green

The insight that unblocked it: removing a class that has NO rule cannot change a pixel, so the
«needs a live screen» part only applies to WRITING a missing style, never to deleting a no-op one.
Twelve classes removed from the markup (`app`, `alt`, `tip-net` ×3, `goal-jar`, `advisor-main`,
`rev-name-txt`, `grp-fact-label`, `filt-sec-title`, `pulse-cats`, `pulse-save-main`,
`top-subs-card`, `ai-model-list`). The thirteenth, `lp-top-signin`, was on the list BY MISTAKE —
`landing.css` has styled it all along (caught by C9 the moment I removed it; restored). ROADMAP card
deleted. If any of these was an intent (`pulse-cats`, `top-subs-card`, `advisor-main` are the
likeliest), it comes back together with its rule.

### ✅ C1 DONE (as a ratchet + one real seam) — check + build green

Measured: `worker/repo` was outside lint C3 entirely, and five of its files had passed the 400 cap
unnoticed (analytics 1006, transactions 915, planning 521, categories 503, tax 476). Rather than a
blind overnight split of 1000-line query files, `worker/repo` now sits under C3 with those sizes as
exceptions that may only shrink — and one real seam was cut straight away: the `health_history`
queries → `repo/health.ts` (analytics 1006 → 971). `src/store/api.ts` (~1390 lines) is client code,
outside C3; splitting it with RTK's `injectEndpoints` is a clean follow-up but touches every hook
import — left for a daytime session.

### ✅ C8 DONE — check green, 1169/1169 tests

`error-paths.test.ts`: `errorBody` (owner sees the raw cause + method/path + ref; a stranger sees
only `internal_error` + ref, no schema leaks; non-Error throws and empty messages still produce the
contract), an uncaught throw inside the user's object end to end (500 JSON for both owner and
stranger — never an empty body), and the JSON 404. `numParam` on garbage was already pinned in
`bad-input.test.ts`. **Gap left, stated:** the client's `errText()` cannot be loaded by the node
test runner (its i18n dictionaries are JSON imports); its half of the contract is the shape pinned
here.

### ✅ C7 DONE (lint C19) — check + build green

17 exports were referenced by no other file and not used in their own. Read one by one before
deleting, because a dead function is sometimes a MISSING CALL:
- deleted (leftovers): `touchLogin` (password path gone), `setSuggestionOutcome` (a second writer of
  advice outcomes beside `scoreTakenSuggestions`, which is the one that runs), `resetRateLimits`
  (a test seam no test used), `removeFromIndex` (operations are never deleted), `migrationNames`,
  `isReadOnlyTool`, `SCOPES` (+ its now-unused import), `isAuditedField`, `formatBase`,
  `KNOWLEDGE_CORPUS` (its comment claimed to be the fallback; the fallback lives in
  `buildKnowledgeCorpus`);
- used instead of deleted: `RuleMatchType` now types `RuleRow.match_type`;
- **kept, and it is a finding:** `markVerified` — a token that goes bad AFTER it was saved is never
  recorded, so an expired monobank token still reads «verified». New ROADMAP card.
C19 (`check-dead-exports.mjs`) keeps it from growing back; 4 names kept on purpose with reasons.

### ✅ C6 DONE — check green

The i18n lint already covered key parity, unused keys and runtime-built prefixes. Added the half it
could not see: an ENGLISH string that still carries Cyrillic is untranslated — except ФОП / ЄСВ and a
quoted foreign UI label («…», “…”). Measured first: exactly 7 such strings, all legitimate, so the
check ships with zero exceptions. Probed with an injected Ukrainian value (flagged), file restored.

### ✅ C10 DONE (lint C18, as a ratchet) — check green

`check-section-index.mjs`: every §TAG cited in code must be defined in CLAUDE.md / docs / DESIGN.md.
Measured first: 171 tags cited, **49 defined nowhere** — ids of finished roadmap rounds (§R2-ST1,
§CH4, §A2…) whose cards were deleted as the process demands, leaving the pointer. Inventing 49
definitions after the fact would be fiction, so they are a LEGACY list that may only shrink; any new
undefined tag fails the build. The reverse direction (14 documented rules no code cites, e.g.
§JEV-EVAL, §CHART-REF) is deliberately NOT enforced — process and design rules need no code pointer.
Every tag introduced tonight is defined.

### ✅ C2 DONE (lint C17) — check + build green

CLAUDE.md's «a page with `data?.x ?? []` must have an error branch» is now `check-error-branch.mjs`
(C17, in `npm run check`). It found **10** components that rendered a failed request as «nothing
here»: the Merchant page, the capital trend card, the what-if sliders, the health mini-card, the
Reports list, the facts card, «similar operations», the reimbursement block, the translit check in
Setup, and the event page (a failed request fell through to «group not found»). All now show
`ErrorNote` with a retry. 6 exceptions, each with its reason (picker options the middleware
already toasts; a polled background indicator; a decorative colour lookup). Probed: flags the old
Merchant page.

### ✅ A2 DONE (cases only, by design) — check green

20 new held-out `subs` cases in `worker/test/__eval__/sites.json` (now 40: 23 subscription / 17
not), each marked `added: 2026-09-25`, written BEFORE any line moves (§JEV-EVAL). Shapes the set
lacked: a membership vs the same brand's orders (Glovo Prime / Glovo), a platform-named bill
(Apple.com/bill), annual billing (Rozetka Premium vs the Rozetka shop), Cyrillic bills (Укртелеком,
Воля, ОСББ), a tiny dollar plan, a monthly pharmacy (the hardest near-miss), fuel/DIY/taxi rhythms.
The §SUB-REVIEW lines (0.5 / 0.4) were NOT touched. File formatting preserved (one case per line).

### ✅ F2 DONE (§QUERY-PARSE) — check + build green, 1165/1165 tests

The search box now reads a sentence: «кава понад 200 у травні без Starbucks» → category Кава,
amount ≥ 200, May (Kyiv calendar, the latest non-future May), exclude Starbucks. Every recognised
piece shows as a removable chip under the box (`GET /transactions/parse`), and every unrecognised
word stays text (each word must match) — nothing is dropped silently. The same parser serves
`find_transactions` for the in-app chat AND the MCP server, so a second assistant writing a sentence
into `query` gets the filters. Table-driven tests in both languages, plus route tests.
**Bugs found on the way:** the feed's plain `q` was a bare `LIKE` («кава» never found «Кава»), and
`find_transactions` had the same gap in BOTH its `query` and `category` params — all now
`orLikeClause`.
Not done: the command palette (`/search`) still does its own simple search — it is a different UX
(jump to a thing, not filter a list).

### ✅ S4 DONE (§FX-EXPOSURE) — check + build green, 1154/1154 tests

`GET /insights/fx-exposure` + `FxExposureCard` (Advisor → Стан; silent for one currency): money
and spending split by currency (spending by the OPERATION's currency — a dollar subscription from a
hryvnia card is dollars), and a stated what-if: every foreign currency +10% against the reader's
base → capital change and monthly spending change, side by side (they pull opposite ways for
someone who saves AND pays in dollars). Assets reconcile to `/summary`'s total.
**Batch S complete** (S1 committed share, S2 payday effect, S3 income rhythm, S4 FX exposure) —
all four on Advisor → Стан, none seen live.

### ✅ S3 DONE (§INCOME-RHYTHM) + a bug — check + build green, 1151/1151 tests

**Bug found on the way:** `/analytics/income` computed its stability CV only over months that HAD
income — the §HEALTH-INCOME bug the health index had already been fixed for — so the income card
could call income «стабільний» while the health index scored it low. Now ONE definition, `incomeCv`
(zero-filled, 6 complete covered months), shared by the health index, the income card and the new
rhythm; a test with a jobless month pins that all agree and that the hole makes income LESS stable.
**The statistic:** `GET /insights/income-rhythm` + `IncomeRhythmCard` (Advisor → Стан): longest wait
between arrivals, days since the last (warned only when it already beats the longest), months
income covered the recurring floor, and the spread. Goldens unchanged.

### ✅ S2 DONE (§PAYDAY-EFFECT) — check + build green, 1147/1147 tests

`GET /insights/payday` + `PaydayCard` (Advisor → Стан, after the committed card): discretionary
spend in the week after an income arrival vs an ordinary week, «×1.8». Anchored on real receipts
(≥ ¼ of a typical month, merged within 3 days) so it works for irregular income; bills and
essentials excluded; null under 3 events; the card stays silent within ±15%. Tested on a ledger
built WITH the effect (ratio > 2) and one without (≈ 1).

### ✅ O4 DONE (data side) — check + build green, 1142/1142 tests

**Found a real defect:** the report computed its OWN burn («mean of the last 3 completed months»)
and a runway from it — a second definition beside the canon's `sumLevels`, so a report could quote
a runway no other screen shows. Now `forecast.monthly_burn_uah` is the canonical burn (pinned equal
to the chat snapshot's), with its recurring/lumpy split.
**More informative:** the report saw only the period's own numbers, so it could only narrate the
Statistics screen. `report-news.ts` now hands it the app's verdicts: the health index (same object
the chat gets), the committed share of income and its trend, the subscriptions whose latest cycle
is late/missing/stopped/changed (§PLAN-STATE — the most actionable line a report can carry), and
the stack's drift — with a note telling the model to open with the health band, put
subscriptions-that-need-attention in the first section, and END with what is coming.
**Not measurable tonight:** whether the generated TEXT is better needs a paid run (no paid calls at
night; §AI-EVAL). Listed under Blocked.

### ✅ O3 DONE (bug + conservative redesign) — check + build green, 1141/1141 tests

**The clipping bug:** the day popover was an absolute child of the cell inside `.cf-grid`, which
has `overflow: hidden` for its rounded canvas — so the popover under the last row, or past the
card's edge, was cut off. Now `DayPopover` renders it into `body` (portal), measures it, places it
below the day, flips it ABOVE when there is no room, clamps it to the viewport with an 8px gutter
(works at 400px), closes on scroll/resize/Escape, and does not catch the pointer.
**Redesign, deliberately conservative** (the rest needs a live screen): the hover rule was dead
(`border-color` on a borderless cell) → an inner ring; the open day gets an accent ring so it is
clear which day the floating popover belongs to; weekday header in sentence case (DESIGN §2); the
inflow colour was defined in two files and rendered teal text on a green pill → one rule, teal.
**Owner's eye:** open the calendar, hover a day in the bottom row and a Saturday/Sunday on the
right edge, and try it on the phone. Anything bigger (cell density, the heat tint) is a judgement
on the live screen and is listed under Blocked.

### ✅ O2 DONE — check + build green, 1141/1141 tests

One rule for percentages of a set: `shared/pct.ts` — `wholePcts` (largest remainder, always sums
to 100) and `pctOf` (one part of an explicit whole). Pinned by `pct.test.ts`. Applied: «з чого
складається місяць» tooltip (MonthStack) now shows % of the month; the spend donut's legend now
shows money AND % (it had only %); merchants, accounts and events on Statistics carry «N% витрат»
of the period; importance cards, the report donut, the account currency split and the category
page's composition (server) switched from per-part rounding to the set rule (they could read
99/101). Category page itself got its share line in O5.
Not converted, on purpose: single ratios that are not part of a set (floor share of burn, budget
projected %, knowledge-corpus fill) — per-part rounding is correct there.

### ✅ O5 DONE — check + build green, 1138/1138 tests

**Category page:** «N% усіх витрат за <range>» above the tiles (a new `share_of_total_pct`, pinned:
the shares of all root spend categories sum to 100); a settings card — importance, monthly limit,
name/colour/icon. **Subscription page:** a settings card — amount/period/count (the plan's amount
could not be edited ANYWHERE before), category, other-names note, two-step end; linked charges at a
non-declared price carry a ±% chip; plus the state banner, «Якщо скасувати» and trial from F1.
Not done here on purpose: a «business» flag on the category — business status is a property of
the operation/account (§TAX-BASE), a category-level switch would contradict the canon.

### ✅ F1.1 DONE — check + build green, 1136/1136 tests

Two of the six planned items already existed (price history = §PRICE-STEPS on the plan page;
yearly plans at their monthly weight = §SUB-MONTH), so the work went into the rest:
`GET /planned/stack` + `SubsStackCard` (what linked charges ACTUALLY took per month for a year,
drift, two-of-a-kind as a question, trials that just turned paid) and, on a plan's page, «Якщо
скасувати» (per month, per year, points of committed income) with a trial line. The stack's
monthly total is pinned equal to the hero's. `POST /planned` moved into `services/plans.ts` for C3.
**Owner's eye:** the two cards have not been seen live; «two-of-a-kind» uses the LEAF category,
which may still be too coarse on real data — if it nags about a legitimate pair, the next step is a
per-pair dismiss.

### ✅ S1 DONE — check + build green, 1130/1130 tests

`GET /insights/committed` + `CommittedCard` (Advisor → Стан, under the floor card): the recurring
floor as a share of typical income, what is left, and a 6-month trend. §FLOW-SERIES extracted from
`health.ts` so «typical month's income» has one definition (health goldens unchanged). Decisions
worth the owner's eye: plans are NOT added on top (they are already in the floor); the tax reserve
is NOT in it (an outstanding total, not a monthly rate); the card is never green. **S2 was
redefined** — the original (merchant concentration) already exists as §SPEND-PROFILE; see the S2
card.

### ✅ A1 DONE — check + build green, 1127/1127 tests, lint C16 live

One helper for Cyrillic case (`lib/platform/text.ts`) at four sites; the plan search's old variant
builder had been missing UPPER CASE («КИЇВСТАР»). C16 refuses `LOWER(…) LIKE` in worker SQL (probed
against HEAD: flags exactly the two old sites). Side finds fixed: `TRANSFER_CAT = 13` was defined
twice; `enrich.ts` split (`enrich-history.ts`) for C3. ROADMAP card deleted.
Not touched, noted: `repo/transactions.ts` has `GROUP BY LOWER(t.merchant)` — not a LIKE, but the
same fold failure: «СІЛЬПО» and «Сільпо» group separately there.

### ✅ O1 DONE — check + build green, 1124/1124 tests

**The formula was mostly right, and wrong in three places** (all pinned in the new
`worker/test/health.test.ts`, which is the first test of the formula itself — the golden only ever
pinned one number on one ledger):
1. Zero income scored **stability 100%** (cv is 0 when the mean is 0) — six jobless months earned the
   full 15 points. Now 0.
2. Parts the data cannot measure were graded anyway: stability from one month = 100%, and an EMPTY
   account read as «six months without income» because `coveredMonths` falls back to months the
   ledger does not have. Now such a part is unmeasured, left out, other weights renormalised;
   `fullyCoveredMonths` is the no-fallback core of the same rule. Under half the formula measured →
   `insufficient`: the UI shows «—» and no band, and the score is not recorded.
3. The card's four «points» disagreed with the gauge in **288 of 960** sampled cases (independent
   rounding). Now allocated server-side by largest remainder — they always sum to the score.

**Hover:** trend is a Recharts area (fixed 0..100) with a tooltip — score, band, the four parts'
points each ± against the previous recorded day, and «moved most». Needs the parts per day →
**migration 0055** (`health_history.pts_*`). The daily run now records the index too
(`drafts-health.ts`); before, it was written only on page open, so `health_drop` never fired for
someone who was not looking.

**AI:** `healthForModel` adds the same index (score, band, parts, 30-day change, provisional flag)
to `collectFinanceSnapshot`, with a note that forbids recomputing it.

**Owner — before deploy:** migration **0055** is pending (`db:migrate:remote` per the deploy
routine; the DO embed is regenerated). Unseen live: the tooltip on the dark `.chart-tip`, and the
provisional state on a new account.

### ✅ F1.0 DONE (02:01–~03:00) — check + build green, 1115/1115 tests

Implemented as designed below, with these specifics worth knowing:
- `planState` added one kind the design did not have: `no_history` (nothing ever linked — the
  `dead_sub` drafter's story). `stopped` = 3+ missed cycles; `ended` is reserved for the person's
  own decision (inactive / past `end_date`).
- The reprice gate anchors on the last LINKED charge, not on `start_date` (plans are entered by
  hand with approximate dates; linked charges are the biller's real rhythm), and allows 1–3 cycles
  so a single unlinked month in between does not break the chain.
- Accepting the new price is `POST /planned/:id/accept-price` with an EMPTY body — the server
  reads the amount from the latest linked charge, and refuses (409) across currencies.
- `PlannedActual` was declared twice (shared + `plan-match.ts`); now once.
- `plannedActuals` moved to `plan-actuals.ts` for C3 (`plan-match.ts` hit 428/400).
- **Left as is, deliberately:** `draftMissedPlans` still has its own loop, but it now reads the
  SAME constants and walk from `plan-state.ts`, so it cannot disagree with `planState`. Rewriting
  it on top of `planState` is a small follow-up, not done at night because its tests pin wording
  and dedup keys that a refactor could shift.
- **Owner's eye:** the banner's wording and colours (`.plan-state.warn/.bad`) have not been seen
  live. On the owner's ledger, open YouTube's page after the next sync — or press «Знайти
  пропущені списання» — and the 179 ₴ charge should link and the banner offer «Прийняти нову ціну».

### 2026-09-25 01:57–02:20 — F1.0 diagnosed (kept for the record)

The session was restarted before any code changed. **The working tree is untouched**; what follows
is the investigation, so the next session does not repeat it.

**Both defects confirmed in the code, and the owner's YouTube case is explained exactly.**

**Defect 1 — the amount is part of the identity gate.** `worker/lib/finance/plan-match.ts`:
`amountMatches(txAbs, period_amount)` accepts ±10%. 100 → 179 ₴ is +79%, so
`matchActiveSubscription` rejects the charge even though the name matches through §SUB-ALIAS. The
same ±10% window appears a second time as the SQL pre-filter inside `linkPlanHistory`
(`lo = period_amount*0.9`, `hi = *1.1`), so the healing pass cannot find it either — which is why
`paidOnSecondLook` in `worker/lib/messaging/drafts-plans.ts` would also fail to rescue it. The
file's own comment states why the amount gate exists: without it a loose alias could pull an
unrelated purchase from the same merchant into the plan. **So the gate may not simply be widened —
it has to be REPLACED by an equally strong one for the reprice case.**

**Defect 2 — a plan has no state.** `subscription-overview.ts` computes `next_charge` from
`nextChargeUnix(start_date, …)`, pure arithmetic that rolls forward regardless of what happened.
Nothing asks whether the PREVIOUS due date was ever satisfied, so the card serenely showed
24 October for a plan whose September charge it had missed.

**What already exists and must be composed, not rewritten** (this is most of the state machine):
- `drafts-plans.ts`: `lastDueUnix()` (walks back to the most recent due date), `periodSeconds()`,
  `earlyToleranceSec()`, `LATE_GRACE_DAYS = 3` (§PLAN-LATE), `EARLY_TOLERANCE_DAYS = 5` capped at
  half a period, and `paidOnSecondLook()` («not linked» ≠ «not paid»).
- `subscription-overview.ts`: §PRICE-STEPS already groups charges into price steps, `chargeRhythm`
  (§RHYTHM, median gap) already gives the real interval, billing day and skipped gaps.
- `plannedActuals()` already reports `price_change_pct` per plan, and `draftPriceUps` already
  notifies above +10% — **but only for charges that got linked**, which is precisely what defect 1
  prevents. Fixing the match is what makes the existing price-up notification fire for YouTube.

**The design decided on (start here):**

1. **New `worker/lib/finance/plan-state.ts`** — schedule math and plan state, one definition.
   `nextChargeUnix` MOVES here from `subscriptions.ts` and is re-exported from it (so no import
   list anywhere changes), and `periodSeconds` / `lastDueUnix` / the tolerance constants move here
   from `drafts-plans.ts`, which then imports them back. Reason for the move rather than a new
   import edge: `subscriptions.ts` re-exports `plan-match.ts`, so `plan-match → plan-state →
   subscriptions` would close a cycle. With `nextChargeUnix` living in `plan-state`, the arrows run
   one way: `subscriptions → plan-state`, `plan-match → plan-state`.
2. **`planState(plan, charges, now)`** → `paid · due · late · changed · missing · ended`, derived
   from the linked charges against `lastDueUnix` + the early tolerance. §PLAN-LATE is unchanged:
   `late` only after 3 days, and the card asks rather than accuses.
3. **The reprice tier in `plan-match.ts` (§PLAN-REPRICE).** When the amount falls outside ±10% the
   charge may still be the plan's — but ONLY with every one of these, since the amount gate is what
   made alias matching safe: the name matches (`planMatches`), the currency matches, the charge sits
   inside the expected cycle window (due date ± the early tolerance, the same windows
   `drafts-plans` already uses), the cycle has no charge linked to this plan yet, the plan has at
   least one earlier linked charge (an established series — a brand-new plan may not claim a
   stranger), and the amount stays inside a sane factor of the declared one (≈0.2×–5×, so a 10 000 ₴
   purchase can never be read as a repriced 100 ₴ subscription).
   The match is returned FLAGGED as a reprice: `planned_id` is written, `period_amount` is **not**.
   A near-match never silently rewrites money — the card reports «100 → 179 (+79%)» and a person's
   click updates the plan.
4. **`linkPlanHistory`'s SQL pre-filter** needs the same second tier, or the healing pass stays
   blind: widen the amount window for candidate rows and let the JS gate above decide.
5. **The test first:** a fixture with the owner's exact case — same merchant name, same billing day,
   100 ₴ for several months and then 179 ₴ — which must FAIL on today's code (charge unlinked, card
   showing a confident next date) and pass after. Then the state cases: paid, 1 day late (silent),
   4 days late (`late`), a cycle with nothing at all (`missing`), amount changed (`changed`).

**Files to touch:** `worker/lib/finance/plan-state.ts` (new), `plan-match.ts`, `subscriptions.ts`,
`subscription-overview.ts`, `shared/api/planning.ts` (the `SubscriptionOverview` shape gains the
state and the reprice flag — declared ONCE there), `worker/lib/messaging/drafts-plans.ts`,
`src/pages/Subscription.tsx` + `src/pages/Subscriptions.tsx` (C3 ceilings — extract, never raise),
`worker/test/subscriptions.test.ts` and a new fixture.

## Blocked / needs the owner

- **C3 structured outputs / C4 provider adapter — parked.** Both change the transport of EVERY AI
  call (`lib/ai/json.ts`, 207 lines, imported by one test), and neither can be verified without a
  paid run. A wrong `output_config` shape ships as «all AI broken» after the next deploy. C4 has no
  second provider to serve yet (ROADMAP: multi-provider is deferred). Do C3 in a session where one
  `npm run eval` can confirm it; write json.ts tests with a fake fetch first.

- **A3 — batch enrich on §A6-BATCH: not started, on purpose.** `worker/lib/ai/jobs.ts` says in the
  owner's own words that the paying kinds are hung on the batch loop «with the owner watching, not
  overnight», because a wrong stop condition is an alarm that wakes itself forever and pays a
  model each time. Honoured. The ROADMAP card stays.

- **A2 — measure.** `node scripts/eval-sites.mjs --site subs` needs the owner's Jev key. Compare
  the 20 new cases against the 0.5 / 0.4 lines BEFORE considering any move; if the gap closes or
  inverts, that is the finding — do not re-tune on these cases.

- **O4 reports — judge the text.** Generate one weekly and one monthly report (paid) and read them:
  do they open with the health band and the subscriptions that need attention, and end with what
  is coming? If the model ignores `news_note`, the next step is moving those three lines into the
  system prompt proper (`report-prompt.ts`), then `npm run eval`.

- **O3 calendar — the bigger redesign.** Cell density (two inline items + «+N»), the red heat tint
  scaled by the day's total, and whether income days deserve their own row are judgements on the
  live screen. The clipping bug is fixed and the style is aligned; the rest waits for a screenshot.

_(anything that turned out to need a live screen, a live key, or a canon decision)_
