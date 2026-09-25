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
- [ ] **S11. Dashboard** — review against current features, propose, implement.

## Open questions for the owner

- **S11 dashboard** — proposals waiting for a yes (see chat): «Потребує уваги» rail block, goals mini, forecast card on §CASH-PROJ.
- Nothing here has been seen in a browser yet (the Chrome extension was not connected); API shapes were verified on the local `/demo`.

## Log

- 2026-09-25 — S1–S10 done; `npm run check` + `npm run build` green. DESIGN §6 has one row per decision.
