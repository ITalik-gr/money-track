# UI_PASS — dashboard, charts and settings pass (2026-09-25)

> Temporary working document for one owner request. Each step is struck with a one-line result
> when done. Durable decisions move to `DESIGN.md §6` as they land; delete this file when the list
> is empty. Green bar (`npm run check` + `npm run build`) per step. Live check = the owner.

## The request (owner, paraphrased)

1. Main dashboard — review against what the app has become; change/improve.
2. Transaction page: «Робоча операція» is not understood. Redesign the AI block and the Edit card
   (checkboxes especially, «додати тег», the folded «recognised data»).
3. Every chart (lines, stacked %, colours, columns) shows its data on hover — many do not.
4. Cumulative flow: hover per day should say what changed / what is expected; «Накопичено» alone
   explains nothing. Daily regenerated forecast.
5. Top merchants / spend by category rows: the small trend chart is liked — make it bigger and
   hoverable; reuse it on category / merchant pages.
6. AI insight card: long labels collapse into a one-word column (screenshot 1).
7. «Скільки коштує просто жити» and «Скільки доходу вже зайнято» are not intuitive — improve or remove.
8. Redesign «Налаштування категорії» and «Налаштування підписки» (screenshots 2, 3).
9. «Стек підписок»: more informative, hover on the chart.
10. No gap between «Прив'язані операції» and «Налаштування підписки» (screenshot 3).

## Findings before starting

- **«Робоча операція»** is the §TAX-BASE business flag (`BusinessToggle`, ФОП module, owner-only
  while unfinished). Three states: «За рахунком» (inherit the account), «Так», «Ні». It sits INSIDE
  the AI block, which is why it reads like an AI output. It is a human decision about the row.
- **Cumulative flow** already regenerates on every request (`buildCashProjection`: plans by date,
  day/weekday-shaped ordinary spend, detected paydays). The API returns per-day deltas without the
  NAMES of the plans behind them, so the chart cannot say «rent leaves on the 20th».
- **Sparklines** (`ui/Sparkline.tsx`) are 58×20 SVG with no tooltip; `/analytics/spark` already
  returns `buckets` (months), so month labels are available client-side.
- **Sub stack** API returns `paid` per month only — no count, no names.
- **Charts without hover** (CSS bars / columns with a native `title` or nothing): CommittedCard,
  SubsStack, MonthPulse, ForecastCard, CreditBanner, HealthIndexCard, Goals, Accounts (currency
  split, own-funds split), EventDetail, Reports importance bar, StatsOverview importance bar,
  CategoryShape, TxReimbursement, fop BusinessQuarters / Counterparties / BusinessCosts,
  StatsMerchants (events/accounts bars).
- DESIGN §7 names an `impeccable` skill under `.claude/skills/` — that directory does not exist in
  this checkout; the pass follows DESIGN §1–§6 directly.

## Steps

- [x] ~~**S1. Gap**~~ — the settings card now has its own `section-head` outside the card, like every other section on the page; the section spacing comes with it.
- [x] ~~**S2. Trend sparkline**~~ — `Sparkline` takes `months` + `sign` and becomes hoverable (guide line, point, tip: month · amount · ±% vs previous; the running month is marked). New `.trow` rows (category + merchant): name over bar, amount over share · count, 112×32 area sparkline between. Row-level HoverTip removed (its facts are printed now). `HoverTip` flips at the right/bottom edge and accepts `null`. — — hoverable (month · amount · vs previous), bigger in the merchant and
  category rows; row layout redesigned so the chart has room.
- [x] ~~**S3. Cumulative flow**~~ — `CashProjectionDay.items` + `payday`; tooltip per actual day (spent · received · day net · since start) and per projected day (plans by name · income by name / usual payday · everyday spend · expected total); summary line «Зараз · на кінець періоду»; dashed «today» tick. — — API: per-day plan items `{title, amount}`; tooltip: actual day =
  spent · received · net of the day · running total; projected day = planned charges by name ·
  expected ordinary spend · expected income · projected total. Rename «Накопичено».
- [x] ~~**S4. AI insight rows**~~ — the stacking rule was a viewport `@media` that never fired in a narrow column; now `@container` on `.rich`. Delta is a pill in the fact's own tone; the advice note is a callout with an icon; the cost moved to a footer. — — label on its own line when the row is narrow (container query), values
  never squeeze the label to one word.
- [x] ~~**S5. Sub stack**~~ — API `paid[]` gains `n` + `top` (4 plans); taller columns with a tooltip each (month · amount · charges · ±% · plans), dashed average line with a chip, «total over N months» + «peak month». — — API: per month charge count + top plans; hover tooltip on each column;
  amount labels; average line.
- [x] ~~**S6. Category / subscription settings**~~ — shared `.setform` (label + visible hint column, controls left-aligned beside it, hairline rows, footer for the destructive action) and `.affix` (unit inside the input). Save turns primary only when dirty; the current importance level is explained in words; the plan shows «≈ X a month» for non-monthly schedules. — — redesign both cards (clear rows, aligned controls,
  one Save per group, readable labels).
- [x] ~~**S7. Transaction page**~~ — `TxAiBlock.tsx` extracted: why-line, «AI розуміє» quote, status/plan chips, note with its own Save, change log, chat; the duplicate folded table removed. Editor: ФОП flag moved here with an explanation and named options; switch rows instead of sentence-checkboxes; tags = chips + «+ Додати тег» panel. Page also got a real error branch (a failed load no longer says «not found»). Side effect: the Accounts page's account-level ФОП switch (same `.fop-tx` class) now stacks label / segment / note vertically. — — business flag moved out of the AI block into Edit with a plain
  explanation; AI block redesigned; Edit card: checkboxes → switch rows with explanation, tags
  picker redesigned.
- [x] ~~**S8. Floor + committed**~~ — merged into one card «Місячний мінімум» (CommittedCard.tsx deleted, both endpoints kept). — — decide: merge into one card or fix each.
- [x] ~~**S9. Hover everywhere**~~ — `TipBody` helper; tooltips on importance bars (Stats, Reports, Category), currency / own-funds splits (Accounts), forecast pace, credit meter, event plan bar, month-pulse categories, floor chips/segments, committed trend. Left as is (numbers printed right beside the bar): goals, health-index parts, reimbursement, ФОП ranks/quarters, merchant events/accounts rows. — — the remaining bars/columns from the findings list get `HoverTip`.
- [x] ~~**S10. Trend chart on category / merchant pages**~~ — both pages already have full 12-month charts with tooltips; the category page's two merchant lists became `.trow` rows with the hoverable sparkline. — — reuse S2 where the page lacks it.
- [x] ~~**S11. Dashboard**~~ — «Потребує уваги» at the top of the rail (late/missing plans, envelopes over or heading over, transfers without a real category, ≥3 uncategorised this month; composed client-side from the canonical queries, error ≠ «all clear»); «Цілі» mini (two open goals closest to done); the forecast card got the month's cumulative line with the §CASH-PROJ tooltip. Seen live: `.dash-pair` split by the WINDOW left ~190px halves at 1100px — now a container query on `.dash-main`, rail 300px below 1320px, `.pulse-cat` names no longer collapse to 0px. —

## Batch 3 — bugs and gaps for users (found 2026-09-25) · DONE 2026-09-25

> Each item: what the user sees → why (file:line as of 2026-09-25) → the fix → how to prove it.
> Do these BEFORE Batch 2: they are small, and 1–3 are wrong answers on screen today.

- [x] ~~**F1. «Ліміт перевищено» at exactly 100%.**~~ — `shared/envelope.ts` `envelopeState` (§ENV-STATE in CANON): over / full / warn / ok by the PRINTED percentage; grid and attention card both read it; «full» = warn tone, «ліміт вичерпано» / «вичерпано». `envelope-state.test.ts` pins 0.99 / 1.00 / 1.004 / 1.006 / 1.01 and zero envelopes.
  *Sees:* «Потребує уваги» says «Дім і побут, оренда — ліміт перевищено · витрачено 100% ліміту»
  (owner's screen 4). Rent that exactly equals its envelope is not an overspend.
  *Why:* `src/components/dashboard/AttentionCard.tsx:67` tests `b.ratio >= 1`.
  *Fix:* three states — `ratio > 1` → «перевищено» (bad); `ratio === 1` (or within 0.5%, spent ==
  limit after rounding) → «ліміт вичерпано» (warn, new key `att.budgetFull`); pace rule unchanged.
  Check `EnvelopeGrid.tsx` uses the same boundary (it computes its own `over`) so the grid and the
  card never disagree — ideally one shared helper `envelopeState(row)` in `src/lib/`.
  *Proof:* a unit test of the helper at 0.99 / 1.00 / 1.01.

- [x] ~~**F2. Month bounds from the browser's clock, not Kyiv (§APP_TZ).**~~ — the calendar moved to `shared/time.ts` (worker `time.ts` re-exports it + keeps the SQL helpers); every client period bound, date-input conversion and «today» now uses it (dashboard, Stats shell/compare/categories/period bar, Category, Wrapped, cash calendar, Notifications, Subscriptions, Reports, Add, Transactions, Facts, Goal, ФОП). C12 now scans `src/` + `shared/` and also refuses `new Date(y, m, …)` wall times on the client; `app-tz.test.ts` pins 23:30 UTC on 31 Aug → September.
  *Sees:* someone outside Ukraine (or any device in another timezone) gets the wrong month in the
  first/last hours of a month: attention counts uncategorised rows of the wrong month, the 6-month
  cashflow starts a month off, «this vs last month» compares the wrong windows.
  *Why:* `new Date(now.getFullYear(), now.getMonth(), …)` in
  `src/components/dashboard/AttentionCard.tsx:42`, `src/components/dashboard/CashflowCard.tsx:17`,
  `src/components/stats/StatsCompare.tsx:28,68`, `src/components/stats/StatsCategories.tsx:217-222`.
  CLAUDE.md: «Calendar is Kyiv: no `new Date(x).getMonth()` for period bounds»; lint C12 only
  covers the WORKER, which is why these survived.
  *Fix:* take bounds from the server (the forecast already returns `monthStart`/`daysInMonth`; the
  overview accepts `preset` — but mind the rolling period mode, see ForecastCard's comment), or add
  one client helper that computes Kyiv month starts via `Intl` with `timeZone: "Europe/Kyiv"`
  (through `dateFmt()`, never `new Intl.*`). Then extend C12 to `src/` for period-bound code.
  *Proof:* the extended lint fails on the old lines; a test of the helper at 23:30 UTC on the last
  day of a month (already the next month in Kyiv).

- [x] ~~**F3. «No data» while still loading.**~~ — CashflowCard: skeleton of the chart + «—» total while pending (and no «no data» under an error note); KpiRow tiles: skeleton value, no «0 ₴» / «prev: 0 ₴» while loading. Swept: MonthPulse, CapitalTrendCard, SafeToSpend, UpcomingSubs, HealthMini render nothing until the answer (no false claim); ForecastCard's flow chart waits for its data. Throttled-network look = owner.
  *Sees:* on a slow load (seen live, dark theme) the dashboard's «Грошовий потік · 6 міс» flashes
  «Даних для графіка ще немає» and «+0 ₴» — reads as a month that broke exactly even.
  *Why:* `CashflowCard.tsx` builds `rows` from `data?.series ?? []` and renders
  `<CashflowChart rows={rows} />` regardless of `isLoading`; `CashflowChart.tsx:37` prints
  `chart.noData` for an empty array. DESIGN §6: «Loading» and «empty» are different screens.
  *Fix:* while `isLoading` (no data yet) render a skeleton of the real block (`.skeleton` with the
  card's classes) and «—» for the total. Sweep the other dashboard/stat cards for the same
  `?? []` → «empty» pattern while loading (MonthPulse, KpiRow, CapitalTrendCard, ForecastCard's new
  flow chart).
  *Proof:* throttle the network in devtools and reload — no «no data» text before the answer.

- [x] ~~**F4. An expired bank token still shows as verified**~~ — `CredentialRefused` (provider.ts) thrown by mono/privat on 401/403; a provider names its `secret`; `noteCredential` (lib/bank/credentials.ts) after every backfill step, poll, account sync and webhook registration: refused → `last_ok_at = NULL`, first success after → set again, any other failure → untouched. AI transport does the same for `anthropic_api_key`. Settings wording «не звірено або відхилено — збережи ключ ще раз чи заміни його». ROADMAP card deleted, `markVerified` off the C19 KEEP list; `backfill.test.ts` drives outage → 401 → success. (already a ROADMAP card: «A saved token
  that later goes bad is never recorded»).
  *Sees:* monobank stops syncing; Settings still says the token is verified — the user has no clue
  why new transactions stopped.
  *Why:* `markVerified` (`worker/lib/platform/secrets.ts:108`) has no caller; `last_ok_at` is set
  only on save.
  *Fix / proof:* as in the ROADMAP card (401/403 in `lib/bank/mono.ts` and the AI transport mark the
  secret; a test drives a 401 through the sync and the status turns unverified). Delete the ROADMAP
  card when done.

- [x] ~~**F5. Tooltips do not exist on touch.**~~ — `HoverTip` on pointer events: mouse follows as before; touch opens at the finger, closes on an outside tap or any scroll. Sparkline: tap picks the point and does not fall through to the row link; `.trow` keeps the trend on phones at 64×26 instead of hiding it. 390px look = not seen (owner). Every hover added in Batch 1 (`HoverTip`, sparklines,
  stack columns, «Місячний мінімум» segments, goals bar) listens to `onMouseMove` only; on phones
  they never open, and `.spark`/`.trow-spark` are hidden below 640px.
  *Fix:* `HoverTip` opens on tap (pointerdown with `pointerType !== "mouse"`), closes on outside tap
  / scroll; the sparkline picks the tapped point. Consider showing the trend sparkline on phones at
  a smaller size instead of hiding it. Check all Batch 1 screens at 390px (none were seen there).

- [x] ~~**F6. Tooltips are mouse-only for keyboard and screen readers.**~~ — `HoverTip` opens on `:focus-visible` under the element, gives a non-focusable DOM child `tabIndex=0`, and while open the tip (`role="tooltip"`) is the child's `aria-describedby`. Sparkline: focusable `role="img"` with the running month in `aria-label`, ←/→ walk the months. Columns/segments are not
  focusable and the tip content is not announced.
  *Fix:* bars that carry a tip get `tabIndex={0}` + open on focus/close on blur, and an
  `aria-label` summarising the tip (month · amount). Chart containers that are `role="img"` keep a
  full `aria-label`. Pairs with T3/F5 — the same component.

- [x] ~~**F7. «Потребує уваги» silently drops items after six.**~~ — five, then «ще N» that expands in place (six shown whole — «ще 1» would cost the row it hides).
  *Why:* `AttentionCard.tsx:104` — `items.slice(0, 6)` while the header count shows all.
  *Fix:* show 5, then «ще N» that expands in place.

- [x] ~~**FOP1. ФОП stays owner-only until finished — verify and close the two leaks.**~~ — (a) MCP `initialize` instructions built per connection, the ФОП paragraph only when `fopAvailable`; (b) the Accounts «ФОП» badge behind `useFopVisible()`. `fop-gate.test.ts` asserts a non-owner's instructions have no «ФОП»/`get_tax_status`. Remaining «ФОП» words in the client are bank ACCOUNT TYPES (Privat AutoClient card title/hint, mono «ФОП-картка», `acct.sec.fop`) and one example in the «about me» placeholder — not the module. Demo walk-through = owner.
  Owner's decision (2026-09-25): ФОП does not ship to users yet; it must be invisible everywhere
  and ship later in one switch. Audit of today's tree — already gated (§FOP-GATE):
  the `/business` route (`App.tsx` `BusinessRoute`) and its nav item (`Layout.tsx`, `ownerOnly`),
  `BusinessToggle` (operation editor), `AccountBusinessToggle`, `/tax/*` (404), tax context for the
  advisor and safe-to-spend (`taxContextFor` → `{}`), ФОП notifications (`drafts-fop.ts`), the MCP
  `get_tax_status` tool (hidden via `fopVisible`), `UserDO` tax work.
  Leaks to close:
  (a) `worker/routes/mcp.ts:54-56` — the MCP server INSTRUCTIONS text tells every user's assistant
  about `get_tax_status` and ФОП even when the tool is hidden → build the instructions per request
  and drop that paragraph when `!fopAvailable(env)`;
  (b) `src/pages/Accounts.tsx:345` — the «ФОП» badge renders on `is_business === 1` without the
  gate (today only the owner can set the flag, so it is latent) → wrap in `useFopVisible()`.
  Not a leak, keep: the Accounts group «ФОП» (`acct.sec.fop`) is monobank's own ACCOUNT TYPE
  (`type === "fop"`), not the module.
  Also: the ФОП canon questions in ROADMAP → Backlog stay parked until the module ships.
  *Proof:* extend `worker/test/fop-gate.test.ts` to assert the MCP instructions for a non-owner
  contain no «ФОП»/`get_tax_status`; a demo session shows no ФОП word anywhere.

## Batch 2 — owner review of batch 1 (2026-09-25) · DONE except B1 (blocked) and SE1 (proposal awaiting a yes)

> Written down on the owner's instruction «запиши і поки не роби». Nothing below is implemented.
> Order is a proposal: the shared foundations (T1–T3) first, because half of the page items are
> the same two defects repeated.

### Foundations (fix once, everywhere, and add a check so it does not come back)

- [x] ~~**T1. Row hover inside cards.**~~ — chose the INSET pattern: `.ilist` (controls.css, §ROW-LIST in DESIGN §4): list 6px from the card edge, rounded rows, separators inset 12px that fade out on both sides of a hovered/open row (`:has(> .open)` for wrapper rows). Migrated `.trows`, `.att-list`, `.mrows`, `.mo-list`, `.sub-charge-list` (plan page + category subscriptions), `.corpus-list`. Edge-to-edge TABLES stay (`.ledger.rows`/`.tx`, `.nt-row` — clipped by the card radius). C22 `check-row-list.mjs` refuses a hand-drawn `+` separator between hoverable (or unnamed) rows and a row that is both filled and hairlined. Not seen live. Seen on: «Потребує уваги», spend-by-category `.trow`, top
  merchants, «Основні мерчанти» (category page), «Що росте не перший місяць», linked operations on
  a plan page, and many more. Two failure shapes:
  (a) the rounded hover background sits flush against plain hairline separators — a radiused
  fill touching square lines looks broken (screens 4, 5, 11);
  (b) in a `flush` card the first/last row's hover leaves a strip of card padding visible above or
  below it (screen 13), or the separators themselves carry the radius (screen 11).
  → One list pattern for the whole app: either rows with an inset hover (margin from the card edge,
  separators inset to match and hidden next to a hovered row), or edge-to-edge rows whose hover
  fills to the card edge and inherits the card's radius on first/last. Pick one, document it in
  DESIGN §4, migrate every list (`.trow`, `.att-row`, `.mrow`, `.catbar-btn`, `.sub-charge-row`,
  `.mo-row`, drill rows…), and add a lint (C22) that refuses a hover background on a row inside a
  `flush` card that does not use the pattern.
- [x] ~~**T2. Checkboxes.**~~ — one styled checkbox/radio globally (`input[type=checkbox]:not(.switch)`, controls.css): 17px, 5px radius, white SVG tick on the accent fill (same in both themes), indeterminate, disabled, hover. Instant-save on/off settings became `.switch` (semantic search, notification kinds, business/tax module, envelope rollover); pickers (similar ops, CSV, reimbursement, auto-budget, transfer «remember») stay checkboxes. Three local `width:auto` patches removed. Native checkboxes are still unstyled in many places (SimilarTx, CSV import,
  settings, filters…). One styled checkbox (and the `.switch` from S7 where it is an on/off
  setting) applied globally via `input[type=checkbox]`, both themes.
- [x] ~~**T3. Text tooltips (`InfoTip` / `HoverTip` with prose).**~~ — cause: a flipped tip sat at `left: x` near the edge, so the fixed box could only be as wide as the space to its right (one word per line), then `translate(-100%)` moved it. Now a flipped tip anchors by `right`/`bottom`, the flip uses the MEASURED size (layout effect), prose tips get `max-content` capped at 300px. Too narrow (one word per line on
  screen 14), and the width jumps depending on which side of the cursor it opens. → A fixed
  comfortable width for prose tips (~280–320px, `max-width` with `width: max-content` capped), the
  flip decided from the MEASURED tip, not a constant, and no width change on flip.
- [x] ~~**T4. Truncation with a full-text tip.**~~ — `.cb-name` / `.mo-name` are flex boxes, and `text-overflow` does nothing to a flex box's bare text: names now sit in their own ellipsised span, the row carries `title` with the full name (avg check, events, receipts, reports, top days, momentum, `.trow` categories/merchants). «Середній чек по категоріях» cuts category names with
  no ellipsis → `text-overflow: ellipsis` + `title` with the full name; sweep every name cell that
  can truncate (merchant names in `.trow` already truncate — add the `title` there too).

### Dashboard

- [x] ~~**D1. «Власні кошти» card.**~~ — each chip is labelled by its currency CODE (UAH / USD / EUR) over its amount; the three «≈ у валюті» labels are gone (the row has `aria-label` «Власні кошти за валютами»). The two «≈ in currency» pills are unclear — you cannot see which
  currency each one is. → Say the currency by name/code with its amount («$ 9 800», «€ 550»), or a
  small labelled split; drop the repeated «≈ у валюті».
- [x] ~~**D2. Re-layout.**~~ — main column = this month then the long view: forecast FULL width (its month line now 180px tall) → «Вільно до кінця місяця» | «Пульс місяця» → envelopes → 6-month cash flow → capital. «Найближчі списання» moved to the rail under «Потребує уваги». Seen live at 1372px. The month forecast is too narrow in its half of a pair — give it a wider
  slot (e.g. full main-column width, or pair it differently). Rethink the order of the whole main
  column now that attention / goals live in the rail.

### Statistics

- [x] ~~**ST1. Redesign the expandable rows and what they open**~~ — the drill is the open row's own lower half: the row loses its bottom radius, `.cat-drill` continues the same tone with no border and a short slide-in; the nested white «cards» (subcategories / top merchants) are captioned sections; operations are white rows on the tone. Applies to `.trow`, `.catbar-btn`, `.mrow-btn`. Found and fixed on the way: the category drill summed its operations CLIENT-side in their own currencies and printed the display sign («18 105 $» for 18 105 ₴ of rent) — the header now says the count only (the canonical total is on the row). Seen live. (category rows, top days, merchant
  rows, drill panels) in a newer, 2026-feel style consistent with the project — the drill panel
  currently looks like a grey box pasted under a row (screen 7).
- [x] ~~**ST2. Day statistics — fewer blocks.**~~ — one «Коли ти витрачаєш» (`SpendTiming.tsx`): facts (priciest weekday · weekend share · days without spending), one chart with a Weekdays / Days-of-month switch (typical day, hover, click → operations), the five priciest days as chips, one drill slot. Removed `TopSpendDays`, `DeeperAnalytics`, `WeekdaySpend` (two weekday charts over the same endpoint) and the second, conflicting `.wd-*` rule set; the category page's weekday chart uses the same one. 18 dead keys deleted. Seen live. «Найдорожчі дні», «За днями тижня», «Будні проти
  вихідних», «Витрати по днях тижня», «Витрати за числом місяця» are many, similar and not very
  informative. → Collapse into one or two blocks (e.g. one «Коли ти витрачаєш» card with a
  weekday/day-of-month switch and the top days as its highlights).
- [x] ~~**ST3. Move the income blocks higher** on the Trends tab.~~ — «Дохід» now sits right under «Динаміка» (income vs spend); it was the last block of the tab.
- [x] ~~**ST4. «Форма витрат»** — very large and not informative; shrink or rethink.~~ — leads with one sentence («74,5% витрат — це 2 оп. розміром від 48»), a 10px bar with per-bucket tips, a one-line legend, and the two attribution facts as a footer of the same card instead of two more tiles. About a third of its old height. Seen live.
- [x] ~~**ST5. «Стабільність доходу»**~~ — the stability card is the wider half (`.inc-grid` 1 : 1.5), columns 128px with amounts above them and the running month pale; the sentence adds the weakest and strongest full month in money; each column's tip names what arrived (API: `monthly[].top`, up to 3 sources; new `repo/income.ts`). Found on the way: the client matched the LOCALISED stability label against Ukrainian words, so an English screen always read «moderate» — API now has `stability.level`. Golden re-recorded: only the two added fields. Seen live. — widen, add what the spread MEANS (good or not), and hover on
  the columns shows what arrived that month (sources / amounts).
- [x] ~~**ST6. «Що росте не перший місяць»**~~ — rows are `.ilist` (T1); the private non-interactive `Spark` replaced by the shared `Sparkline` (hover / tap / arrows per month) with two new props: `floor0` (baseline 0 for a claim about size) and `running={false}` (complete months only). Not seen live (the demo has no running trend). — hover problems (T1); check the sparkline there too.

### Advisor

- [x] ~~**A1. «Історія порад»**~~ — cause of the double line: the last ROW kept its `border-bottom` because `:last-child` was the «Показати всі» button, which added its own `border-top`. List is `.ilist` now, the button has no border. The advice was cut to «Ти…» because the `nowrap` numbers column took the row: two lines per entry now (date · advice full width, then runway / burn), full text in `title`. Rules moved to advisor.css (C8). — two lines at the bottom of the list above «Показати всі» (a separator
  plus a border, screen 9); the title column is truncated to «Ти…».
- [x] ~~**A2. Layout of «Стан».**~~ — «Місячний мінімум» spans the grid; «Як приходить дохід» | «Валютна експозиція» under it; then payday | facts; calendar full width. Seen live. «Місячний мінімум» full width; under it «Як приходить дохід» and
  «Валютна експозиція» side by side (currency exposure moves to the right column).
- [x] ~~**A3. «Частка постійного в доході»**~~ — renamed «Скільки доходу забирає постійне, по місяцях»; a dashed 70% line on every column with a key; a sentence under it («У серпні 2026 постійне забрало 49% доходу — у травні було 37%.») plus what that share means (room / tight above 70% / over income). At full width the card is two columns (answer + bar + runway | made of + trend, `@container` ≥ 760px). Seen live. is still not understood — rework that part of the card:
  make it say what it means (e.g. a line/area against a 70% «safe» mark, a sentence «у серпні
  постійне з'їло 85% доходу — було 59%», tooltip with fixed / income per month). Make the whole
  card informative at full width.

### Category page

- [x] ~~**C1. Two merchant blocks**~~ — one «Мерчанти» block with a «за період / за весь час» switch in its heading (all time is the fallback when the window is quiet; the concentration line shows on all time). Seen live. — «Мерчанти» (period, shows only 3) and «Основні мерчанти»
  (all time, more). Unclear why two. → One block with a period/all-time switch, or keep one.
- [x] ~~**C2. «Налаштування категорії»** goes to the bottom of the page.~~
- [x] ~~**C3. Income categories**~~ — settings card gets a «Вигляд» row (colour + icon + name, «Змінити» → `CategoryModal`) for every category, so it is never empty. Income audit: header says «Категорія доходу» instead of an importance word; the tile under «Отримано» shows the count, not «0% регулярні»; «Середній чек» → «Середнє надходження» with its own hint; «Мерчанти» → «Від кого»; importance / weekday / projection blocks hidden. And for ANY never-used category: one line («У цю категорію ще не надходило жодних грошей») instead of «— · за 0 активних місяців» over an empty 24-month chart. Seen live on «Зарплата» and «Повернення». (e.g. «Повернення», screen 12): the settings card renders an empty
  body (no rows apply to income) — show what does apply (name/colour/icon at least; hide the card
  otherwise). Audit the whole page for income categories: every block must say something true and
  useful for money coming IN (no spending wording, no envelope, sensible shares).

### Subscriptions

- [x] ~~**P1. Linked operations list** — hover padding strip at top/bottom (T1).~~ — `.ilist` (T1).

### Business (ФОП)

- [ ] **B1. Spacing audit** — gaps between elements and texts across `/business`. **BLOCKED:** `/business` is owner-only (§FOP-GATE) and cannot be opened in the local demo; a static pass found no inline margins and the stack spaced by `gap`. Needs the owner's screenshots (which gaps) or an owner session.

### Settings

- [x] ~~**SE1. Rebuild Settings from scratch for the current app.**~~ — DONE 2026-09-25 on the owner's go-ahead («діли і на таби, і на блоки; неважливе видали, об'єднай»): tabs Загальне · Банки й дані · Сповіщення й доступ · AI · Адмін (owner); every tab split into captioned blocks (`SetBlock`). Merged: bank keys + linked banks + «Стан бази» → one card; «Вийти» + «Вийти всюди» → one card. Folded: a finished first-run checklist is one line. Removed from users' view: the «Обслуговування» tab (repair buttons → owner's «Адмін»). Moved: AI key and semantic search → AI; MCP / quick-add → Сповіщення й доступ. Old `?tab=users|maintenance` links land in «Адмін». Seen live. Original notes: It is bulky: everything is dumped
  there. Remove what is not needed, shrink, merge; sort into tabs and blocks that match the app as
  it is now. Needs an inventory first (every card, who uses it, owner-only or not) and a proposed
  tab map for the owner's yes before moving anything.
  **Inventory (2026-09-25, `src/pages/Setup.tsx`, 5 tabs, 21 cards):**
  - Акаунт (7): Profile · Currency · Telegram · Push · Feedback · Semantic search · MCP · Quick-add ·
    Sessions · Danger zone (the last four hidden in the demo).
  - Дані (7): bank key (`CredentialsCard bank`) · bank connections · AI key (`CredentialsCard ai`) ·
    «Стан бази» (accounts / operations / webhook) · CSV import · Export · Backups.
  - AI (2): usage + cost · AI activity log (`ai_changes`, revertible).
  - Обслуговування (1 card, 2 one-off repair buttons: «find transfers», «apply subscription
    categories») + Log out.
  - Користувачі (owner): Users · Feedback inbox.
  Oddities: the AI key sits in «Дані», not «AI»; «Стан бази» is a debug readout in a user tab;
  «Обслуговування» is a whole tab for two repair buttons nobody needs twice; semantic search (an
  AI feature) sits in «Акаунт»; Log out lives in «Обслуговування».
  **Proposed map (4 tabs + owner tab) — awaiting the owner's yes, nothing moved:**
  1. **Профіль** — Profile, Currency, Sessions + Log out (one «Вихід» card), Feedback, Danger zone last.
  2. **Банки й дані** — ONE «Банки» card (key + connections + the db-state line «N рахунків · M
     операцій · вебхук ✓» folded in), CSV import, ONE «Копії й експорт» card (export + backups).
  3. **Звʼязок** — Telegram, Push, MCP, Quick-add (every channel into / out of the app).
  4. **AI** — AI key, usage + cost, activity log, semantic search.
  5. **Адмін** (owner only) — Users, Feedback inbox, the two repair buttons.
  Net: 21 cards → 17, «Обслуговування» tab gone, nothing removed that a user can use today.

## Open questions for the owner

- Seen live on the local `/demo` at 1184px: dashboard, Stats → categories, Subscriptions + a plan page, an operation page, Advisor → state, dark theme on the dashboard. Not seen: the ФОП flag in the editor (the demo has no ФОП), the AI insight card with a real answer (demo AI is limited), phone widths.

## Log

- 2026-09-25 — owner: (1) §JEV-SHARED — Jev for every account: the user's own TypeSafe key (`user_secrets.jev_api_key`, verified on save, field in Settings → AI) or the owner's `JEV_API_KEY` otherwise (never in a demo). Each judgment on the lent key is counted in the directory (`jev_usage`, **migration directory/0012 — run `npm run db:dir:migrate:remote` before deploy**); the owner sees today / month / all time (requests · tokens · $) and per-account use in Settings → Адмін → «Jev на твоєму ключі». Privacy: users' operation text now goes to TypeSafe — said on the AI key card and in CLAUDE.md. Tests: `judge-tx.test.ts` (non-owner reaches TypeSafe, the counter equals the requests). (2) Settings gaps: «Загальне» and «AI» are one grid each (per-block grids balanced separately and left holes), both key cards and search full width, the first-run line full width; measured column difference ≤ 60px on every tab. check (561) green.

- 2026-09-25 — owner follow-up: (1) weekday chart — rent paid on Sunday the 20th made «Sunday» the priciest day and «weekends eat a noticeable share»: new §WEEKDAY-HABIT figures on `/analytics/weekday` (plan-linked operations and the lump that carries a day left out, both reported), the chart / busiest day / weekend share read them, the tip names the one-off; the open-bar style no longer hides the hatch. Golden: only added fields; `weekday-habit.test.ts`. (2) Advisor: «Факти» | «Корпус знань» side by side, equal height; «Після надходження» full width. (3) SE1 Settings rebuilt (see SE1). (4) Dark theme analysed → ROADMAP card, nothing changed. (5) New-user readiness: owner resources gated (AI key / mono token per user, Jev + TG chat owner-only, ФОП hidden); fixed the global error toast printing the endpoint name («generateAdvice: …») and the «no AI key» hint pointing at a renamed tab — it now links to Settings → AI. check (560) + build green; seen live.

- 2026-09-25 — Batch 2 done: T1–T4, D1–D2, ST1–ST6, A1–A3, C1–C3, P1; B1 blocked (owner-only page), SE1 inventory + proposal written. `npm run check` + `npm run build` green. Seen live on the local demo at 1372px: dashboard, Stats (categories, trends), Advisor → Стан, category pages (expense, income, never-used). Not seen: phones, dark theme, /business.
- 2026-09-25 — Batch 3 done (F1–F7, FOP1); `npm run check` (558 tests) + `npm run build` green. Not seen live: phones, throttled load, demo ФОП sweep.

- 2026-09-25 — Batch 3 (bugs F1–F7, FOP1 audit) written down; to be done before Batch 2.
- 2026-09-25 — Batch 2 written down from the owner's review (screens 4–14); not started, per the owner.

- 2026-09-25 — S11 done and S1–S10 checked live; fixes from the live pass: stack columns capped at 48px, projected axis labels «dd.mm» (was «9/30»), shorter cumulative tooltip labels, «Категорія» capitalised, share trend drops empty leading months («+49 п.п. з квітня» was against a month with no data).
- 2026-09-25 — S1–S10 done; `npm run check` + `npm run build` green. DESIGN §6 has one row per decision.
