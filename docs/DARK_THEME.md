# Dark theme — «Сланець» (Slate)

> **Status: IMPLEMENTED 2026-09-26** (§THEME, lint C23). The durable rules are in `DESIGN.md` §2
> (architecture, token table, rules) and §6 (log row, with where the code kept the design instead of
> this brief). Kept only for the owner's live pass (§7 checklist); delete it after that.
> The palette lab the choice was made on: https://claude.ai/artifact/YAUvoVTkCJ61GN91EYSibw

## 1. The decision

The owner called the current dark theme «дуже погана». Measured causes:

- **No elevation.** `--surface` vs `--surface-2` vs `--line` are ~3% apart; hover fills, drill panels,
  `.ilist` separators, segmented controls and nested blocks melt together (row hover vs card: 1.10:1).
- **Tooltips have no edge.** `.hover-tip` / `.chart-tip` are hard-coded `#0f1620` — the dark `--bg`.
- **White text on the light accent** (primary buttons): 2.87:1 — fails AA.
- **Signals too loud** (`#f0674a`, `#35b37e` at full saturation on near-black).
- **Category colours are the LIGHT theme's** (stored in the DB): pine `#1f6e4c` is dark on dark.
- **Shadows are invisible**, and ~60 hard-coded colours never follow the theme.

**Slate** was chosen: cool graphite with a slight blue bias — the light theme's own cool neutral
(`--bg #f3f5f8`) carried into the dark, with the same cobalt accent lifted so it does not sink. The
product must look like ONE product in both themes (DESIGN §1: «light and dark are equals»).

## 2. How theming works today (facts to build on)

- `src/styles/tokens.css`: light tokens on `:root`, dark on `:root[data-theme="dark"]` (line ~94).
- `public/theme.js` runs before paint and ALWAYS sets `data-theme` (`localStorage["mt-theme"]`,
  default `light`). The app never follows the OS setting. Toggle: `Layout.tsx` (`toggle`), and the
  landing has its own (`Landing.tsx`).
- ⇒ every `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) … }` block in the
  app CSS is **dead** (the attribute is always present): `domains-a.css:193` (`.cat-ai-callout`),
  `settings.css:365` and `transactions.css:242` (`.sub-ai-block`). The explicit-dark twins next to
  them are the live ones, and the two `.sub-ai-block` versions disagree. Keep ONE rule per element.
- `<meta name="theme-color">` is hard-coded `#0b0f14`/`#f3f5f8` in three places: `public/theme.js`,
  `Layout.tsx:92`, `Landing.tsx:76` → one constant each side, updated to the new `--bg`.
- Following the OS theme is NOT part of this task (an explicit toggle is the product today).

## 3. Tokens — the full Slate set

Replace the body of `:root[data-theme="dark"]` with this. **New tokens** (marked ✚) must ALSO be
defined in the light `:root` with values that keep the light theme pixel-identical (right column).

| Token | Slate (dark) | Light value to add / keep | Role |
|---|---|---|---|
| `--bg` | `#0a0d13` | `#f3f5f8` | app ground, sunken inputs |
| `--surface` | `#161b25` | `#ffffff` | cards |
| `--surface-2` | `#1f2531` | `#eef1f6` | nested/inset blocks, tracks, chips, segmented track, drill panels |
| ✚ `--surface-3` | `#28303e` | `#e8ecf3` | one step above `--surface-2`: active segment, hover on a nested block |
| ✚ `--hover` | `rgba(233, 237, 244, 0.06)` | `rgba(15, 22, 32, 0.04)` | hover OVERLAY — works on any surface (see §4.1) |
| `--line` | `#262d3a` | `#e9edf3` | card borders, separators |
| `--line-strong` | `#353e4e` | `#dbe1ea` | inputs, secondary buttons, dashed guides |
| `--ink` | `#e9edf4` | `#0f1620` | text |
| `--ink-2` | `#b4bdcc` | `#3b4656` | secondary text, neutral amounts (transfers) |
| `--muted` | `#8b95a7` | `#5f6b79` | captions, axis labels |
| `--accent` | `#789fff` | `#2e6be6` | cobalt |
| `--accent-strong` | `#9cb8ff` | `#1f57cc` | primary hover (LIGHTER in dark, darker in light) |
| `--accent-soft` | `#1c2845` | `#eaf1fd` | selected/open fills, active nav item |
| ✚ `--on-accent` | `#0b1220` | `#ffffff` | text/icons ON the accent (buttons, checkbox tick, switch knob stays white) |
| `--pos` / `--pos-soft` | `#47c390` / `#13292a` | `#14915f` / `#e6f5ee` | income, good |
| `--neg` / `--neg-soft` | `#f17e6e` / `#2e1c1d` | `#dd4b39` / `#fdecea` | spend, over, errors |
| `--warn` / `--warn-soft` | `#e1ac4e` / `#2b2417` | `#b5790f` / `#fbf1dc` | warning |
| ✚ `--tip` | `#2b3240` | `#0f1620` | tooltip background (every dark tip) |
| ✚ `--tip-line` | `#3b4455` | `#0f1620` | tooltip border |
| ✚ `--tip-ink` | `#e9edf4` | `#ffffff` | tooltip text |
| ✚ `--tip-muted` | `#9aa4b6` | `rgba(255,255,255,0.6)` | tooltip labels (`.tip-lbl`, `.tip-muted`) |
| ✚ `--tip-pos` / `--tip-neg` | `#5fd3a2` / `#ff9585` | the current `color-mix(… white)` values | tones inside a tip |
| ✚ `--overlay` | `rgba(3, 5, 9, 0.62)` | current modal scrim value | modal / sheet scrim |
| ✚ `--float` | `#1f2531` | `#ffffff` | dropdowns, Select popover, command palette, day popover, toasts |
| ✚ `--cat-keep` | `69%` | `100%` | how much of a category's own colour survives (see §4.9) |
| `--c-pine` … `--c-teal` | `#5e9580` `#6893ea` `#9c74b8` `#d3a75e` `#c3716b` `#559fa8` | unchanged | category palette, lifted |
| `--chart-expense` / `--chart-income` | `var(--accent)` / `var(--pos)` | same | |
| `--shadow-sm` / `--shadow` / `--shadow-card` | `none` / `0 8px 24px rgba(0,0,0,.35)` / `none` | unchanged | dark elevation comes from colour + border, shadow only on floating layers |

Contrast (WCAG, on `--surface`): ink 14.9 · ink-2 9.1 · muted 5.7 · accent 6.7 · neg 6.5 · pos 7.8 ·
on-accent on accent 7.3 · card vs bg 1.13 · `--surface-3` vs surface 1.30 · tip vs surface 1.34.
Any new pair must keep text ≥ 4.5 (body ≥ 7) — check with the same formula.

## 4. Rules by element (what «looks right» means)

### 4.1 Elevation and hover
- Ladder: `--bg` (page) → `--surface` (card, ALWAYS with a 1px `--line` border in dark) →
  `--surface-2` (inset/nested) → `--surface-3` (raised inside nested) → `--float` + shadow (floating).
- **Hover is an overlay, not a surface.** Every row/button/tile hover uses `background: var(--hover)`
  (or `background-image: linear-gradient(var(--hover), var(--hover))` where the element already has
  a background). A fixed hover colour is wrong on a nested block: `.ilist` rows inside a `.cat-drill`
  (which is `--surface-2`) currently hover to `--surface-2` = invisible. Sweep every `:hover {
  background: var(--surface-2) }` (≈ 35 rules, `grep -n ":hover" src/styles/*.css`).
- **Selected / open / active** is not hover: `--accent-soft` fill, `--accent` text or icon (open
  `.trow`, active sidebar item, `.chip.on`, open weekday column, open day in the calendar).
- `.ilist` separators: `--line`; they already hide beside hover/open rows — keep.

### 4.2 Buttons
- Primary: `--accent` bg, `--on-accent` text, hover `--accent-strong`. (Today white on light accent.)
- Secondary `.btn`: `--surface` bg, `--line-strong` border, hover overlay; ghost: transparent + overlay.
- Danger text: `--neg`; danger solid: `--neg` bg + `--on-accent`-like dark text (`#1a0d0b`) —
  check contrast.
- Focus: `:focus-visible` outline `2px var(--accent)` — already global, keep visible in both themes.

### 4.3 Inputs, selects, textareas
- Sunken: `--bg` background, `--line-strong` border, `--ink` text, `--muted` placeholder.
- Focus: border `--accent`, ring `0 0 0 3px var(--accent-soft)` (the light theme's neutral ring
  rule in `controls.css` stays for light).
- `.affix` unit: `--muted`. Disabled: 0.5 opacity, no hover.

### 4.4 Checkbox, radio, switch, segmented
- Checkbox (`controls.css`, T2): the tick is a WHITE data-URI SVG — on the light Slate accent it
  must be `--on-accent`. Use `mask-image` with the same SVG and `background-color: var(--on-accent)`
  on a pseudo-element, or a second data-URI under `[data-theme="dark"]`. Unchecked: `--surface`
  fill (not `--bg`), `--line-strong` border.
- Switch: track off `--line-strong`, on `--accent`; knob `#fff` in both (visible on both tracks).
- Segmented `.seg`: track `--surface-2`, active `.seg-btn` = `--surface-3` + inset `--line-strong`
  1px (not `--surface`, which is DARKER than the track in dark and reads as a hole).

### 4.5 Tooltips (every one)
`.hover-tip`, `.chart-tip`, InfoTip prose tips, `.cum-tip`, calendar day popover:
`background: var(--tip); border: 1px solid var(--tip-line); color: var(--tip-ink)`; labels
`--tip-muted`; tones `--tip-pos`/`--tip-neg`; `.d` colour dots unchanged. Replace the hard-coded
`#0f1620` and every `rgba(255,255,255,…)` inside tip rules (`dashboard.css` ~219–240).

### 4.6 Charts (Recharts + CSS charts)
- Expense `--chart-expense`, income `--chart-income`; area fills 0.12–0.16 opacity of the stroke.
- Grid `--line` (strokeOpacity 1 in dark, not 0.6 — too faint), axis text `--muted`, reference
  lines `--line-strong` dashed with an opaque chip (`--float`) label.
- Bars/columns on a `--surface-2` track; heat maps (`.dom-heat`) mix the accent with `--surface`,
  NOT with `transparent` (transparent over a dark card goes muddy).
- Sparklines: stroke the given colour; end dot tone from `--pos`/`--neg`; guide `--line-strong`.
- Hatched «lumpy» bars: `repeating-linear-gradient` with `--accent` at ~45% opacity.

### 4.7 Pills, chips, badges, deltas
- Semantic: `*-soft` background + full-colour text (`.pill.pos`, `.cmp-delta`, `.stab-badge`,
  `.sub-badge.warn/.bad`, envelope states). Neutral chip: `--surface-2` + `--ink-2`.
- Envelope/progress bars: track `--surface-2`, fill = category colour (lifted) or `--warn`/`--neg`.

### 4.8 Money
- Spend amounts `--neg`, income `--pos`, transfers `--ink-2` (DESIGN §6 «transfer is neutral»).
- Hero numbers `--ink`; the currency sign `--muted`.

### 4.9 Category colours (stored light colours → dark)
- The DB holds the light palette (`#1f6e4c` …) and components paint it inline
  (`style={{ background: c.color }}`). ONE rule, no per-screen fixes: a helper in `src/lib/`
  `catColor(c) = \`color-mix(in srgb, ${c} var(--cat-keep), var(--ink))\`` used everywhere a
  category/plan/goal colour is painted (dots, bars, donut segments, icon tiles, sparklines).
  `--cat-keep: 100%` in light → identical pixels; `69%` in dark → the lifted values in §3.
- The local `FALLBACK = [...]` hex arrays (`MonthPulse.tsx`, `SpendDonut.tsx`,
  `IncomeBreakdown.tsx`, `stats/shared.tsx`) → `var(--c-*)` tokens.
- Icon tiles with `#fff` letters (`.cat-ico`, `MerchantLogo`): keep white text; check contrast on
  the lifted colour (≥ 3:1 for the 12–17px bold letter). Brand tiles keep brand colours.

### 4.10 Floating layers, modals, toasts
- Dropdowns (`Select`), command palette, day popover, toasts, context menus: `--float`,
  `--line-strong` border, `--shadow`.
- Modals / bottom sheet: panel `--surface` + `--line` border, scrim `--overlay`.
- Skeletons (`.skeleton`): base `--surface-2`, shimmer `--surface-3` (today it mixes `--surface`,
  which is DARKER than the base in dark → a dark sweep).

### 4.11 Page-specific
- Sidebar: keep its current ground; the active item is `--accent-soft` + `--accent` text, hover is
  the overlay, «Add» is a primary button (so `--on-accent` text in dark).
- Danger zone card: `--neg-soft` background, border `color-mix(--neg 35%, --line)`.
- AI blocks (`.sub-ai-block`, `.cat-ai-callout`, `.ai-block`): ONE rule each (see §2), tinted
  `color-mix(in srgb, var(--accent) 10%, var(--surface))`.
- Calendar (`calendar.css`): day tint scaled by total — mix `--neg` with `--surface`, not
  transparent; today = accent pill with `--on-accent`.
- Landing (`landing.css`) has its own `--lp-*`: check it against the new tokens, do not restyle it.

## 5. Hard-coded colours — sweep, then a lint

Counts on 2026-09-26 (hex outside `tokens.css`/`landing.css`): domains-a 22, budgets 10, dashboard
10, ledger 5, shell 5, settings 4, controls 2 (the checkbox tick SVGs), chat 1, domains-b 1,
subscriptions 1, topbar 1; `rgba(` in 7 files; inline hex in components: category defaults and
`FALLBACK` arrays (~80 occurrences, mostly `#c9871a #127c86 #7a3e9d #2e6be6 #b23a2e #1f6e4c`).
- Each one becomes a token, or a `color-mix` of tokens, or stays with a one-line reason
  (a brand colour, `#fff` on a coloured tile).
- Then **lint C23** (`scripts/check-css-colors.mjs`): no raw hex / `rgb(a)` in `src/styles/*.css`
  outside `tokens.css` and `landing.css`, and no raw hex in `style={{…}}` in `src/`, with a KEEP
  list that only shrinks (same discipline as C19/C20). Encode the SVG data-URI `#` as `%23`.

## 6. Order of work

1. Tokens (§3) in both themes, light pixel-identical (compare screenshots of the dashboard, stats,
   a category page and settings before/after in LIGHT).
2. Hover overlay + selected rules (§4.1) — the single biggest visual fix.
3. Tooltips, buttons/on-accent, checkbox tick, segmented, skeleton (§4.2–4.5, 4.10).
4. `catColor` + FALLBACK arrays (§4.9), charts (§4.6).
5. Hard-coded sweep + C23 (§5); dead `prefers-color-scheme` blocks and duplicates removed (§2);
   `theme-color` constant.
6. `npm run check` + `npm run build`; DESIGN §2 table gets a dark column, §6 a row; this file deleted.

## 7. Verification (live, local `/demo` with the dark toggle)

Every screen at 1372px and 390px: dashboard (attention, forecast chart + tooltip, envelopes),
transactions (list hover, filters, date inputs), an operation page (editor switches, AI block, tags),
Statistics — every tab (donut, `.trow` hover + open drill, sparkline tip, «Коли ти витрачаєш»
switch + heat map, shape bar), a category page (expense, income, never-used), subscriptions + a plan
page (state banner, stack columns + tip), Advisor → Стан (floor bar, trend with 70% line), calendar
(day popover), Settings — every tab (checkboxes, switches, key inputs, danger zone), modals (add
category, goal), command palette, toasts. For each: hover is visible on EVERY surface level, no text
below its contrast floor, no light-theme colour left over, and the light theme is unchanged.

## Appendix — the other shortlisted palettes (kept for later, not chosen)

Keys: `bg / surface / surface-2 / hover-step / line / ink / accent / pos / neg / warn / tip`.
- **A Графіт** — neutral cool graphite, closest to light: `#0b0d11 #171b22 #20252e #29303b #262c36 #e8ecf2 #6f9bff #45c28e #f07b6b #e0aa4c #2b313c`.
- **C Чорнило** — blue-violet ink, «premium»: `#0a0c16 #161a2a #1f2437 #282e45 #262b41 #eceefb #8aa6ff #48c69c #f3857b #e4b35c #2a3048`.
- **D Тепла сажа** — warm near-black, OLED: `#0a0a0b #19191c #212124 #2b2b30 #2a2a2f #eeeef0 #7c9dff #56c291 #ec7c6c #dfab50 #303036`.
- **F Опівніч** — navy without violet: `#080b14 #141a2a #1c2336 #252d44 #232b40 #eaeefa #7ea3ff #46c59a #f2837a #e3b15a #28304a`.
- **G Антрацит** — cold neutral near-black: `#09090b #18191c #212226 #2b2c31 #2a2b30 #eeeff2 #779bff #52c190 #ee7d6d #dfab50 #2f3036`.
- **H Чорнило на OLED** — near-black page, ink cards: `#050609 #151827 #1e2235 #272c44 #252a40 #eceefb #8aa6ff #48c69c #f3857b #e4b35c #2a3048`.
All passed the same contrast floors as Slate. Rejected earlier: **B Нічна ялина** (green-tinted).
