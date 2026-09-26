# Money Track — design system

> **Read FIRST before any UI/UX work.** Source of truth for visual intent; tokens are implemented
> in `src/styles/tokens.css`. If this file and the CSS disagree, this file is the intent — fix the
> CSS, or update this file if the intent changed on purpose. Client engineering and CSS
> architecture — §8; the design queue — `ROADMAP.md`. Every design change gets a line in §6.

## 0. Workflow

1. The owner sends a reference screenshot + a feature description.
2. Analyse it: mood · grid and rhythm · type · colour · how numbers are shown · components ·
   depth · what to take and what to leave (against §1) · questions if ambiguous.
3. Record the decision (§6, and §2 if the system changes), then code.

A reference is an ingredient, not a recipe: take a specific device, not the whole dashboard.

## 1. Philosophy

Light dashboard in the spirit of DeliFin, cobalt accent, desktop-first. «A precise instrument»,
but warm and friendly — not the old strict dark-mono.

- **Money is the hero.** Numbers never jump (`tabular-nums` everywhere).
- **Quiet, disciplined surroundings.** Air, restrained colour, minimal decoration.
- **Signature element — account cards** (matte «physical» cards, no glossy gradients).
- **Deliberately NOT the AI default.** No purple gradients, glassmorphism for its own sake or
  generic SaaS-landing look. Cool spruce + cobalt.
- **Honest numbers:** own funds and debt are never mixed; plus/minus have their own muted colours.
- Light and dark themes are equals, not «light with inversion».

## 2. Tokens (`src/styles/tokens.css`)

**§THEME — how theming works.** Three layers, and a colour lives in exactly one of them:
1. `src/styles/tokens.css` — theme-INDEPENDENT: scales, fonts, motion, the stored category palette
   (`--pal-*`), physical card faces (`--card-*`), and derived roles written once in terms of theme
   tokens (`--c-*`, `--chart-*`, `--hover-layer`).
2. `src/styles/theme-light.css` / `theme-dark.css` — one file per theme, the SAME set of colour
   tokens in each (lint C23). Light is also the bare `:root` default. A new colour role = a token
   in every theme file, never a `[data-theme] .thing` twin rule.
3. `src/lib/theme.ts` — the only code that switches (`useTheme()`, `setTheme()`; `THEMES`); it
   writes `data-theme` on `<html>`, `localStorage["mt-theme"]` and `<meta name="theme-color">`
   (read from the live `--bg`). `public/theme.js` applies the stored choice before first paint.
A new theme = a `theme-<name>.css` with the full set + its name in `THEMES` + its `--bg` in
`public/theme.js`; C23 fails until all three agree. The app does not follow the OS setting (an
explicit toggle is the product).

**Colour tokens** (light · dark «Сланець»)

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#f3f5f8` | `#0a0d13` | app ground |
| `--surface` | `#ffffff` | `#161b25` | cards |
| `--surface-2` | `#eef1f6` | `#1f2531` | nested/inset blocks, tracks, chips, drill panels |
| `--surface-3` | `#e8ecf3` | `#28303e` | raised inside a nested block |
| `--raised` | `#ffffff` | `#28303e` | the ON chip of a segmented control |
| `--float` / `--float-2` | `#ffffff` / `#eef1f6` | `#1f2531` / `#28303e` | popovers, Select, palette, toasts / a tile on them |
| `--field` | `#ffffff` | `#10141c` | inputs (sunken in dark) |
| `--hover` | `rgba(40,70,130,.08)` | `rgba(233,237,244,.06)` | hover OVERLAY, any surface |
| `--overlay` | `rgba(10,16,24,.45)` | `rgba(3,5,9,.62)` | modal / sheet scrim |
| `--line` / `--line-strong` | `#e9edf3` / `#dbe1ea` | `#262d3a` / `#353e4e` | borders / inputs |
| `--ink` / `--ink-2` / `--muted` | `#0f1620` / `#3b4656` / `#5f6b79` | `#e9edf4` / `#b4bdcc` / `#8b95a7` | text |
| `--accent` / `-strong` / `-soft` | `#2e6be6` / `#1f57cc` / `#eaf1fd` | `#789fff` / `#9cb8ff` / `#1c2845` | cobalt / hover / selected fill |
| `--on-accent` · `--on-neg` | `#fff` · `#fff` | `#0b1220` · `#1a0d0b` | text on a solid accent / neg |
| `--pos` · `--neg` · `--warn` (+`-soft`) | `#14915f` · `#dd4b39` · `#b5790f` | `#47c390` · `#f17e6e` · `#e1ac4e` | signals |
| `--tip*` | `#0f1620` ground, white ink | `#2b3240` ground, `#3b4455` edge | every tooltip |
| `--cat-keep` | `100%` | `69%` | how much of a stored category colour survives |
| `--shadow-*` | low, cool | none at rest; `--shadow-float` on floating layers | elevation |

Contrast on dark `--surface`: ink 14.9 · ink-2 9.1 · muted 5.7 · accent 6.7 · on-accent 7.3.
A new text pair keeps ≥ 4.5 (body ≥ 7).

**Rules.** Hover is `var(--hover)` (or `background-image: var(--hover-layer)` on a control with
its own fill) — never a fixed surface, which vanishes on a nested block. Selected/open is
`--accent-soft` or `--surface-2`, not hover. Resting cards are flat with a border in both themes.
**§CAT-COLOR:** the DB stores the light palette; every inline paint of a stored colour goes through
`catColor()` (`src/lib/theme.ts`, mixes toward `--ink` by `--cat-keep`), a missing one uses
`CAT_FALLBACK` / `var(--c-*)`. Category colours: pine `#1f6e4c` · cobalt `#2e6be6` · plum
`#7a3e9d` · ochre `#c9871a` · brick `#b23a2e` · teal `#127c86`.

**Type — one family.** Geist Sans carries headings, labels, body AND all numbers (tabular figures,
`"tnum" 1`, class `.money`). Geist Mono ONLY for codes (PAN `··4932`, MCC, IDs) — never money.
Labels are sans sentence-case, never UPPERCASE-mono. Fixed rem scale `--fs-xs 11 … --fs-4xl 36`
(no fluid `clamp()`); hero numbers bump at `min-width:640px`.

**Card padding.** `.card` HAS default padding (`--sp-5` = 20px) — a new card remembers nothing.
Another padding → a modifier class, never inline. A wrapper card whose inner list brings its own
padding → `className="card flush"`. Debt: ~24 inline `style={{ padding }}` on `.card`.

**Scales.** Radius `--radius-xs 6` · `-sm 10` · `--radius 14` · `-lg 18` · `-xl 22` · `-pill 999`.
Space (4pt) `--sp-1 4 … --sp-8 32`. Shadow: `--shadow-sm` / `--shadow` / `--shadow-card`, low and
cool — never heavy drop shadows. Motion: `--ease-out` / `--ease-std`, `--dur-1 120` · `-2 180` ·
`-3 240` ms; motion = state, not decoration; `prefers-reduced-motion` is global.
`--sidebar-w 248px` · `--content-w 1240px`.

## 3. Layout

Desktop-first: sticky left sidebar + a multi-column dashboard grid. Mobile (PWA): bottom tab bar
(short labels `nav.tab.*`, 52px targets, label hidden < 360px), one column, safe-area.

## 4. Established patterns

`.seg` segmented control (children need `.seg-btn`) · `.chip` filters · `.rank` rows with a
proportion bar · modal = bottom sheet on mobile, centred dialog on desktop · envelope fill ·
`Select` instead of native `<select>` · `Range` (`.rng`) instead of native range · `.disclose` —
the ONE disclosure control (not `<details>`) · `ErrorNote` / `.err-note` for failures ·
`EmptyCard` for an empty block · skeletons (`.skeleton`) · `.btn.sm` / `.btn.xs` for sizes ·
`.judge-suggest` for every Jev/AI proposal · **§ROW-LIST** `.ilist` — the one list of rows inside a
card: inset 6px from the card edge, rounded rows, inset separators hidden beside a hovered/opened
row (lint C22); a table (`.ledger.rows`, the notification feed) runs edge to edge instead.

## 5. References (what we took)

- **R1 DeliFin ⭐ base:** sidebar + topbar frame, asymmetric grid, KPI tile (label → number →
  delta pill → «vs last month»), dual-line cashflow chart, balance card with quick actions.
  Not taken: P2P quick-transfer.
- **R2 Lefstyle:** AI-insight card, «financial health» gauge. Not taken: earthy palette.
- **R3 Finexa:** budget card with state badge («Almost reached» / «On track»), horizontal
  category bars. Not taken: purple.
- **R7 Cazura:** subscriptions card (brand logo + name + amount + next charge), transaction
  table with sub-tags. Not taken: teal as the main accent.

## 6. Decision log

Standing rules distilled from the log up to 2026-09-21 (the full history is in git and
`HISTORY.md`). New decisions go into the table below as one row: date · decision · why.

**Layout and spacing**
- Spacing between cards comes from the CONTAINER (grid + gap, e.g. `.biz-stack`), never from card
  margins — a tab that does not render would leave an orphan gap.
- A block in a 2-column grid may not vanish: `EmptyCard` instead of `return null`, and the grid
  gets `> :only-child { grid-column: 1 / -1 }`.
- Both halves of `.dash-pair` share the same anatomy (section header OUTSIDE the card).
- A list inside a card trims padding at both ends; a block that follows another without its own
  section carries its own `margin-top`.
- A «title left + meta right» strip becomes a column at ≤ 620px.
- In `.section-head` only the FIRST button gets `margin-left: auto`.
- The page's main action lives in `page-head`, not in a `section-head`.
- Density follows the SECTION width (`@container`), not the window.
- A control's position may not depend on the content it pages through (lightbox arrows).
- A segmented control inside a settings card is as wide as its options, not stretched.
- `overflow-x: hidden` on both `html` and `body`.

**Numbers and money**
- The currency sign is a value, not a glyph: `baseSign()`, `{cur}` in dictionary strings
  (§BASE-CUR). The balance hero is the TOTAL in the reader's currency.
- Own funds of a credit card may be negative — never `Math.max(own, 0)`.
- A transfer between own accounts is neutral: no sign, `--ink-2`, ⇄, «from → to»
  (`lib/transfer.ts` mirrors `SPEND_WHERE`/`INCOME_WHERE`).
- A compensated / cancelled expense shows what it cost you, with the charged amount struck
  through below (§COMPENSATION, §VOID-PAIR); the «cancelled» pill is muted, not red.
- A zero envelope shows a WORD, not a percentage and no bar (§BUDGET-ZERO).
- Tone comes from the VALUE, not the slope: rising spend is red, falling is green.
- A bar that can overflow must overflow (the worst month is the reason the block exists).
- A fact already the size of a number needs no chart around it.
- Do not show a breakdown of ONE part. Say «too early» instead of a confident-looking forecast.
- A neutral state is not green (`.idle`, muted).

**Charts**
- Y-axis width is `width="auto"`, never a number (`src/lib/chart.ts`).
- A month label comes from an explicit `ym`, NEVER from a period-end timestamp.
- A reference-line label is an opaque CHIP — the problem is the background, not the ink.
- Axis floor is 0 for trend sparklines. No focus outline on Recharts.
- Bars animate with `transform: scaleX/scaleY`, never `width`/`height`.

**Controls and states**
- Base styles of a control live on ITS class, not on the container's.
- `input[type=checkbox|radio]` are excluded from the global `input { width:100% … }` rule.
- A borderless field must reset the global focus ring explicitly.
- Vendor pseudo-elements (`::-webkit-…`, `::-moz-…`) are never grouped in one selector list —
  one unknown selector drops the whole rule.
- `.modal-wide` needs `.modal.<class>` specificity (a later `.modal { max-width }` wins by order).
- Hover lift only under `@media (hover:hover) and (pointer:fine)`.
- Skeletons render the REAL block's classes. «Loading» and «empty» are different screens.
- An AI proposal is a sentence + ONE button beside the control it would move, shown only when it
  would CHANGE the answer; accepting it is the person's click (`is_business`, importance, limits).
- «Paid» opens a list of candidate operations (date · who · amount), loaded lazily; the app
  proposes, the person chooses.
- A rule you cannot preview cannot be saved (Check before Save).
- A statistic gets a correction, not a delete. An undone AI change stays visible at 0.6 opacity.
- No emoji as icons: `✨` → `<Icon spark>`.
- The streamed answer is paced per frame, half-drawn blocks are trimmed, no blinking cursor;
  the typing dots show only until the first word.
- A screen that is read once a year (`/wrapped`) is built from ordinary cards, not its own
  visual language.

**Brand**
- The mark follows the display currency as drawn ARTWORK (`favicon.svg` = dollar default,
  `icons/mark-uah.svg`, `icons/mark-eur.svg`, `useBrandMark()`); the installed icon cannot follow.
- Icons are rendered from SVG with `sips` (keeps alpha); glyphs are placed by measured numbers,
  no `dominant-baseline`. No `--` inside SVG comments (strict renderers reject the file).
- Landing styles live only in `styles/landing.css`; no blanket `z-index` rules on `.landing > *`.

| Date | Decision | Why |
|---|---|---|
| 2026-09-26 | Dark theme palette = **«Сланець» (Slate)**: cool graphite with a slight blue bias, the light theme's cobalt lifted to `#789fff`, a 4-step elevation ladder, hover as a translucent overlay, dark text on the accent. Shortlisted alternatives (keys `bg / surface / surface-2 / hover-step / line / ink / accent / pos / neg / warn / tip`): Графіт `#0b0d11 #171b22 #20252e #29303b #262c36 #e8ecf2 #6f9bff #45c28e #f07b6b #e0aa4c #2b313c`; Чорнило `#0a0c16 #161a2a #1f2437 #282e45 #262b41 #eceefb #8aa6ff #48c69c #f3857b #e4b35c #2a3048`; Тепла сажа `#0a0a0b #19191c #212124 #2b2b30 #2a2a2f #eeeef0 #7c9dff #56c291 #ec7c6c #dfab50 #303036`; Опівніч `#080b14 #141a2a #1c2336 #252d44 #232b40 #eaeefa #7ea3ff #46c59a #f2837a #e3b15a #28304a`. | Owner: the current dark theme «дуже погана»; chosen from a palette lab of seven (https://claude.ai/artifact/YAUvoVTkCJ61GN91EYSibw). |
| 2026-09-26 | §THEME implemented: themes split into `theme-light.css` / `theme-dark.css` (same token set, C23), one switch module `src/lib/theme.ts` (both toggles share state; `theme-color` read from `--bg`), `catColor()` for stored colours, ~45 hover fills → overlay, tooltips/popovers/toasts/scrims/fields/segmented/checkbox tick/skeleton on tokens, every hard-coded colour gone from app CSS and components. Kept from the design, not the brief: primary button stays ink (§10.2), `.sub-ai-block`/`.ai-block` stay neutral cards, open `.trow` stays `--surface-2`. Light moved slightly in three places: hover overlay (#eef0f5 vs #eef1f6), one scrim value (0.4/0.5 → 0.45), fallback palettes for uncoloured rows now cycle the six category tokens. | The old dark theme was overrides plus ~140 colours that never followed it; each fix was a rule to remember, so the whole class is now a failed check. Not seen live yet. |
| 2026-09-25 | One styled checkbox/radio app-wide (17px, 5px radius, white tick on accent); an instant-save on/off setting is a `.switch`, a picker is a checkbox. Tooltips open on tap and on keyboard focus (`HoverTip`), a flipped tip anchors by `right`/`bottom` and flips on its measured size; prose tips are `max-content` ≤ 300px. | T2/T3/F5/F6: OS checkboxes in both themes; tips that did not exist on phones or for keyboards; prose wrapped one word per line near the edge. |
| 2026-09-25 | A drill is the open row's lower half: the row loses its bottom radius, the panel continues its tone with no border, inner blocks are captioned sections (no card in a card). Statistics → Trends has ONE «when» block (facts · weekday/day-of-month switch · priciest days as chips · one drill slot). «Форма витрат» leads with its one sentence. | ST1/ST2/ST4: «a grey box pasted under a row»; five similar day blocks; the biggest block of the tab for one fact. |
| 2026-09-25 | Dashboard main column = this month then the long view (forecast full width → free/pulse → envelopes → 6-month flow → capital); upcoming charges in the rail. Balance chips are labelled by currency code. «Місячний мінімум» is two columns at full width, its trend has a 70% line and a sentence saying what the share means. | D1/D2/A2/A3 from the owner's review. |
| 2026-09-25 | §ROW-LIST `.ilist` replaces every hand-made list (category / merchant trend rows, «Потребує уваги», accounts, «Що росте», linked operations, knowledge docs): rows inset from the card, rounded, separators inset 12px and faded out on both sides of a hovered/open row. C22 refuses a hand-drawn separator between hoverable rows. | Owner, screens 4, 5, 11, 13: a rounded fill touching square lines, and a padding strip over the first hovered row of a flush card. Not seen live yet. |
| 2026-09-25 | Dashboard (UI_PASS S11): «Потребує уваги» card tops the rail (one row per thing to fix, tone on the icon only, links to where it is fixed; «all clear» only when every source answered); «Цілі» mini in the rail; the forecast card carries the month's cumulative line. `.dash-pair` splits by `@container` on `.dash-main` (≥ 620px), not by the window; the rail is 300px below 1320px. | Owner: dashboard behind the app. Live at 1100px the window-based pair left ~190px halves and hid the month-pulse names. |
| 2026-09-25 | Hover everywhere (UI_PASS S2–S9): every chart segment, column and sparkline answers a hover through `HoverTip` + `TipBody` (label with colour · value · one line of context); native `title` tips replaced. `HoverTip` flips at the viewport edge and hides on `null`. Shared dark-tip vocabulary: `.tip-kv`, `.tip-sec`, `.tip-big`, `.tip-muted`, `.tip-pos/neg`. | Owner: «далеко не всюди при ховері показується інфа». Not seen live yet. |
| 2026-09-25 | `.trow` trend rows (spend by category, top merchants, category page merchants): name over bar, amount over share · count, a 112×32 area sparkline between that is hoverable per month (the running month says so). | The liked 58×20 sparkline could not be read or pointed at. Not seen live yet. |
| 2026-09-25 | Cumulative flow: summary line «Зараз · на кінець періоду», a dashed «today» tick, and a tooltip that says what moved the day (actual: spent · received · day net · since start; forecast: plans by NAME, income by name or usual payday, everyday spend, expected total). API: `CashProjectionDay.items` + `payday`. | «тіки накопичено пише при ховері, не зрозуміло що це». Not seen live yet. |
| 2026-09-25 | `.setform` settings pattern (category + subscription): label with a visible hint left, controls left-aligned beside it, hairline rows, destructive action in a footer; `.affix` puts the unit inside the input; Save turns primary only when dirty. | Screenshot: labels and their controls 1 500px apart, hints only behind (i). Not seen live yet. |
| 2026-09-25 | Operation page: the ФОП flag moved from the AI block into the editor with an explanation and named options («Як рахунок · особиста», «Робоча», «Особиста»); the AI block shows «AI розуміє» as a quote + status/plan chips, the note has its own Save, the folded duplicate table is gone; checkboxes became switch rows (title + what it changes); tags are chips + «+ Додати тег». | «Робоча операція, не розумію що це». Not seen live yet. |
| 2026-09-25 | §FLOOR and §COMMITTED merged into «Місячний мінімум»: one number, one bar on the income's length (fixed · uneven · left, overshoot drawn past an income mark), legend, one runway sentence, parts chips, the share trend. | «інтуїтивно не зрозумілі, інфи особливо не дають» — one idea told twice, each needing the other. Not seen live yet. |
| 2026-09-25 | AI insight rows stack under `@container (max-width: 560px)` on `.rich` (was a viewport `@media` that never fired in the narrow column); delta is a pill in the fact's own tone; the advice is a callout; cost moved to a footer. Sub stack: columns with plan-level tooltips, dashed average line with a chip, «total over N months» + «peak month». | Screenshots 1 and 3. Not seen live yet. |
| 2026-09-25 | §PLAN-STATE banner (`.plan-state`, `.warn`/`.bad`) above a subscription's tiles, with ONE action (accept the new price / find the charge); the next-charge tile shows the EXPECTED date in `--neg` while overdue; list cards swap the «next» badge for a `.sub-badge.warn/.bad` word. | The YouTube card promised next month's date for a plan whose current charge it had missed. The border carries severity so the sentence can ask instead of accuse. Not seen live yet. |
| 2026-09-25 | Transactions search: under the box, one chip per understood condition («сума · понад 200», «крім · Starbucks» in a red tint), each removable with a click that deletes its words from the query. | A parser that silently narrowed the list would be worse than none. Not seen live yet. |
| 2026-09-25 | Cashflow calendar: the day popover is a portal placed from the day's rect (flips above, clamps to the viewport, closes on scroll/Escape, no pointer events); hover = inner ring (the old border hover drew nothing), open day = accent ring; weekday row sentence case; inflow = teal text and pill, one rule. | «попап міні обрізається якщо виходить за межі календаря» — `.cf-grid` needs `overflow: hidden` for its rounded canvas, so the popover had to leave it. |
| 2026-09-25 | §PCT-SUM: every composition shows money AND share; shares of one set are rounded as a set (`shared/pct.ts`, largest remainder) so a legend always sums to 100. Donut legend: name · amount · %. | Owner: «скільки відсотково ця категорія займає, бо зараз майже завжди тіки гривні». |
| 2026-09-25 | Category page: one line above the tiles — period total · «N% усіх витрат за <range>»; a «Налаштування категорії» card (importance segment, monthly limit with Save/Remove, «Назва, колір, іконка» → `CategoryModal`). Subscription page: «Налаштування підписки» card at the end (amount + every N months/weeks + Save, category `Select`, other-names textarea + Save, two-step «Завершити»); linked charges at a non-declared price carry a ±% chip. | Owner: «налаштування мо якісь прям там» and «скільки відсотково ця категорія займає». Nothing saves on blur. Not seen live yet. |
| 2026-09-25 | §SUB-STACK card under the Subscriptions hero: drift pill (+red / −green by value), a sentence with the two averages, 12 month columns of what was ACTUALLY charged, then «Trial ended» rows (link to the plan) and «Similar subscriptions» as questions. Subscription page: «Якщо скасувати» card — per month, per year, points of committed income, and a trial line. | The stack drifts while every row looks small; a cancel decision needs its size in the reader's own terms. Duplicates are questions — a household can have two phones. Not seen live yet. |
| 2026-09-25 | §COMMITTED card on Advisor → Стан, under the floor card: percentage FIRST (`--fs-3xl`), money sentence beside it, one income-length bar, six month columns with their own % labels. Tone: neutral ink below 70%, `--warn` from 70%, `--neg` past 100% — never green. | A share of income taken by fixed costs is never «good» on its own terms; the owner asked for percentages next to hryvnia. Not seen live yet. |
| 2026-09-25 | Health trend = Recharts area on a fixed 0..100 axis with a tooltip (score · band · four parts' points, each ± vs the previous day, «moved most»), replacing the bare sparkline. A provisional index shows «—» and no band. Unmeasured parts use `.idle` (no signal colour). | «Can't hover it and see what the score was». A score alone teaches nothing; the part that moved names what to look at. Not seen live yet. |

## 7. Working on design (skills — mandatory)

1. Start of each design session: `node .claude/skills/impeccable/scripts/context.mjs`, then
   `impeccable/reference/product.md` (our register is **product**, not brand) and this file.
2. **impeccable** is the main tool: `critique`, then `layout` / `typeset` / `colorize` /
   `animate` / `polish`. Its absolute bans are law (side stripe, gradient text, default
   glassmorphism, hero-metric template, identical card grids, an eyebrow over every section).
3. **review-animations** must be invoked explicitly on every animation change.
4. **design-taste-frontend** — reference only (it is for landings): anti-slop rules.
5. The impeccable hook runs the detector after UI edits — fix what it finds, do not silence it.
6. `npm run check` + `npm run build` before "done". Live check = the owner.

## 8. Client engineering and CSS architecture

- `src/index.css` is only `@import`s; rules live in domain files under `src/styles/`. An
  overflowing file gets a new seam, never a raised line cap. `landing.css` is the only place for
  marketing rhythm. Tailwind, Sass, CSS Modules and CSS-in-JS were rejected: tokens are already
  central, themes switch at runtime, class names are documented here, and the "why" comments on
  rules would be lost.
- **§COND-ORDER:** `@media` / `@container` add no specificity — a conditional rule must sit BELOW
  its unconditional twin (import order is the cascade). Lint C11.
- **C15:** a `var(--x)` nobody defines silently drops the whole declaration; use a token or
  `var(--x, fallback)`.
- **C20 (2026-09-25):** no declaration that a later rule for the SAME selector always overrides. The
  «8 selectors declared twice» were really 37 dead declarations; removed with the effective cascade
  PROVEN identical (every property of every top-level selector, every conditional block).
- **C23 (2026-09-26, §THEME):** theme files hold the same token set; no colour literal, theme token,
  `[data-theme]` or `prefers-color-scheme` rule anywhere else; a stored colour is painted only
  through `catColor()`. Exceptions only shrink (`landing.css`, the pickers' stored palettes, brands).
- A block whose content is history does not hide on an empty current period; loading ≠ empty ≠ error.
- Per-user `localStorage` keys are scoped by user id.
- **§SET-FLOW:** Settings cards flow in CSS columns (`columns: 2`, `set-full` spans all), not a grid.
- **§CHART-REF:** a reference line is not rounded to the data's precision, is labelled, and the axis
  has headroom (`max × 1.18`).
- **§SIGN-FOLLOWS-DATA:** a block that ignores the page's currency filter takes `baseSign()` itself
  and accepts no `sign` prop.
