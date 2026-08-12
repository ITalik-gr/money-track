# STYLES.md — the client's style architecture

> **What this is.** A plan for `src/index.css`, which is one file of 4 237 lines holding every
> style in the application. It states what is measurably wrong, which of the obvious fixes were
> rejected and why, and the phased plan that was chosen instead.
>
> **What this is NOT.** It is not the design system — tokens, patterns, references and the decision
> journal live in `DESIGN.md`, and that file stays the source of truth for how things should LOOK.
> This one is only about where the rules live and what stops them sprawling again.
>
> Written 2026-08-12. Status: **phase 0 done** (76 dead blocks removed) and **the file is split**
> into nine parts under `src/styles/`, proved byte-identical; lint C8 keeps it that way.
> Phase 0.5 (the 8 conflicting duplicates) and phase 4 (true domain grouping) still need the
> owner's eye — see §6.

---

## 1. Measured state

Every number below is from `src/index.css` on 2026-08-12, not an impression.

| | |
|---|---|
| Lines | **4 237** — in a single file |
| Rule blocks | ~**2 046** |
| Distinct class prefixes (`.goal-`, `.chat-`, …) | **153** |
| Custom properties on `:root` | 63 |
| `@media` blocks | **94**, scattered from line 238 to line 4 235 |
| `@keyframes` | 10 |
| Section banner comments | 49 |
| `!important` | **2** |
| `transition: all` | **0** |
| Selectors nested three levels or deeper | **15** |

**The last three lines matter as much as the first.** This is not a neglected stylesheet. There is
almost no specificity warfare, no `!important` habit, no `transition: all`, the naming is
consistently component-scoped, and the theming runs through 63 tokens rather than scattered
literals. Whatever is wrong here, *the CSS itself is not badly written* — which is exactly why the
fix below is about ORGANISATION and not about replacing the language.

---

## 2. What is actually wrong

### 2.1 One component's rules are spread across thousands of lines

This is the whole problem in one table. First and last line where each family appears:

| Family | First | Last | Spread |
|---|---|---|---|
| `.cat-` | 859 | 4 089 | **3 230 lines** |
| `.goal-` | 807 | 3 770 | 2 963 |
| `.tx-` | 898 | 3 688 | 2 790 |
| `.chat-` | 2 731 | 3 812 | 1 081 |
| `.sub-` | 3 198 | 3 936 | 738 |

Nobody chose this. It is what happens when the only place to add a rule is "the end of the file",
repeated for a year. The cost is not aesthetic: to change how a goal card looks you must first
find all of its rules, and nothing tells you when you have found them all.

### 2.2 Responsive behaviour is nowhere near the thing it modifies

94 `@media` blocks, spread across the entire file. A component's base rules are in one place and
its behaviour at 620px is 2 000 lines away, so the narrow-screen case is invisible while you edit
the wide one — and the narrow case is the one that gets broken. The repo already has scars from
this class of problem: the horizontal-scroll bug (`min-width: 0` on flex children) and the
`overflow-x: hidden` on `html` are both fixes for something that was only visible in one viewport.

### 2.3 Roughly 60 colour literals live outside the theme blocks

`#fff` appears **26 times** below the token definitions, `#c9871a` seven times (that value is
already `--warn`), and a dozen more one-offs. Each is a small landmine for the dark theme, which is
not a variant here but an equal citizen — a hardcoded `#fff` is correct in one theme and wrong in
the other, and the wrongness shows up on someone else's screen, not on the author's.

The DESIGN.md review checklist already asks reviewers to look for "local hardcoded colour". Asking
a human to notice one line in four thousand is not a check, it is a hope.

### 2.4 The file contains 76 duplicated rule blocks — and 8 that quietly conflict

Found while adding a button to a habit row, which is exactly how this kind of thing gets found:

- **19 selectors appear more than once with a byte-identical body**, for **76 redundant blocks** in
  total. `.hb-row`, `.hb-name`, `.hb-when`, `.hb-amt` each appear **five times**; the `.wd-*`
  family up to **six**. Whole sections — comment, rules and trailing `@media` — were pasted again.
- **8 selectors appear more than once with DIFFERENT bodies.** These are not duplicates, they are
  accidental overrides, and they are the ones that bite:

  ```
  .wd-col   line 2289 → flex: 1; …; height: 100%
  .wd-col   line 2301 → min-width: 0; …        ← twelve lines later, no height, no flex
  ```

  Neither wins outright. CSS merges them, so what actually renders is `flex: 1` and `height: 100%`
  from the first plus everything from the second — a rule **nobody wrote and nobody can see**.
  `.tx .amt`, `.runway-val`, `.runway-comment`, `.topbar-brand .name`, `.cat-card .cat-ico` and
  `.corpus-doc` are in the same state.

**Why this is the most expensive item on the list.** Edit `.hb-row` at line 581 and nothing
happens, because the copy at line 4226 wins. The edit is correct, the file is saved, the screen
does not change. That is precisely the "you can't tell what's going on in there" experience, and
it is not a matter of taste — it is four identical copies of the same rule, in a file too long for
anyone to notice.

⚠️ **The identical ones are safe to remove; the conflicting ones are not.** Deleting a block that
has a byte-identical copy LATER in the file cannot change rendering — the later one already won for
every property it declares. The conflicting ones DO change rendering when collapsed, because
today's appearance is the accidental merge. They need a decision per case and a visual check, which
is why they are their own phase.

### 2.4.1 What phase 0 actually did (2026-08-12)

76 dead blocks deleted; the file went 4 258 → 4 182 lines and the build is unchanged.

**How it was proved safe, and it was not by inspection.** For every selector, the ordered list of
DISTINCT consecutive bodies was computed before and after; the edit was written to disk only when
that list was identical for all 153 families, and when no selector had lost its winning body. The
first attempt at a broader rule was ABORTED by that check — it would have altered `.wd-col` and
`.wd-bar-wrap`, whose conflicting body sits in the MIDDLE of their copies, so dropping an earlier
identical one changes which body precedes it. That is precisely the case a human eye skims past.

**What deliberately stayed, and why:**
- **9 selectors still duplicated** — the 8 conflicting ones from §2.4 plus `.hb-row` (whose last
  copy is a deliberate override added the same day). These are phase 0.5: each changes rendering
  when collapsed, so each needs the owner's eye.
- **Duplicates INSIDE `@media` blocks were not touched.** The pass only matched top-level
  single-line rules; the `@media (max-width: 720px) { .hb-grid … }` block, for one, still exists
  five times. Extending the same proof to nested rules is safe in principle but was not done, so it
  is not claimed.
- **A few comments are now orphaned** — they describe rules that no longer sit under them (around
  the old `.hb-*` copies). Left alone on purpose: phase 4 moves these families into domain files
  and will sweep them, and cosmetic comment surgery in a 4 000-line file is exactly the kind of
  unverifiable edit this plan is trying to stop making.

### 2.5 Nothing prevents any of the above from continuing

There is no rule about where a new component's styles go, because there is only one place they
CAN go. This is the same failure the worker had before the ARCH phase, and it was solved there the
same way it should be solved here: give each domain a file, then add a check that keeps the claim
true (`ARCHITECTURE.md` §3, lints C1–C7). **The reason `worker/routes/api.ts` is not 3 331 lines
any more is not that someone split it — it is that C3 refuses to let it grow back.**

---

## 3. Options considered and rejected

### 3.1 Tailwind — rejected

The most-suggested answer, and the wrong one for this codebase.

- **It solves a problem this project does not have.** Tailwind's pitch is that hand-written CSS
  drifts into specificity wars, dead rules and inconsistent spacing. Measured: 2 `!important`, 15
  deep selectors, 63 tokens covering colour, spacing, radius and motion. The design system is
  already centralised; Tailwind would re-express it, not fix it.
- **It would delete the most valuable thing in the file.** The comments. `.pill-toggle` carries the
  note about why it must not be scoped to its container; `.split-remainder` carries the bug where
  green meant "fine" while saving was impossible; `.cb-val` carries why a width without
  `flex-shrink: 0` is only a wish. In utility classes there is no place for any of that — the
  knowledge would move to a commit message, which is where knowledge goes to die.
- **The migration is not incremental in practice.** 2 046 rules against ~100 components; a
  half-migrated app has two styling systems and the reviewer must know both.
- **Honest counter-argument:** it would make a new component's styling faster to write, and it
  makes design drift structurally harder. Real benefits — just not worth the price *here*, where
  the design system is one person's and already documented.

### 3.2 Sass / SCSS — rejected

- The features actually wanted are **nesting** and **file splitting**. Native CSS now has nesting
  in every browser this app supports, and Vite inlines `@import` at build time. So Sass would buy
  a build dependency and a second language for something the platform already does.
- Variables are worse than what exists: Sass variables are compile-time, and this app switches
  themes at RUNTIME. Every colour must stay a custom property regardless.
- **When to revisit:** if loops or mixins ever become genuinely needed (e.g. generating a
  category-colour set programmatically). Right now the category palette is 14 hand-picked values
  that are meant to be hand-picked.

### 3.3 CSS Modules (`*.module.css`) — rejected, with regret

- The right idea (styles scoped to the component that owns them), but it hashes class names, and
  this project has three things that depend on the names being global and stable: the `impeccable`
  detector hook, `DESIGN.md`, which documents patterns BY CLASS NAME, and the theme system.
- It would also touch every `className` in every component — a diff of thousands of lines in which
  a real change is invisible.

### 3.4 CSS-in-JS — rejected outright

The CSP is `style-src 'self' 'unsafe-inline'` today only because React writes `style` attributes.
A runtime style injector adds a bundle cost and a per-render cost to solve a problem that is not
about runtime at all.

---

## 4. The plan: split by domain, keep plain CSS

**The principle, stated once:** the file layout mirrors the component layout. `src/components/stats/`
has `src/styles/stats.css`. This is the same rule the worker already lives by — *a file is a
domain, and a new file that fits nowhere means the domain was not thought through* — and it is
worth having the same rule on both sides of the app.

```
src/styles/
  tokens.css      — :root, both themes, every custom property. THE ONLY FILE WITH COLOUR LITERALS.
  base.css        — reset, element defaults, typography, focus rings, scrollbars
  layout.css      — app shell: topbar, nav, page-head, content width, the responsive frame
  ui.css          — primitives with no domain knowledge: btn, card, pill, select, modal, toast,
                    skeleton, empty-card, tooltip  (mirrors components/ui/)
  dashboard.css · stats.css · transactions.css · advisor.css · planning.css ·
  accounts.css · settings.css · landing.css      (mirror the components/ folders)
  utilities.css   — the genuinely global helpers (.row, .label, .num-mono, .muted)
  animations.css  — @keyframes + the prefers-reduced-motion blocks
```

`src/index.css` becomes an index: `@import` in cascade order, nothing else. Vite inlines the
imports at build, so this costs **zero** extra requests and zero runtime.

**Three rules that come with the split:**

1. **A component's `@media` blocks live in that component's file, next to its base rules.** The
   file is small enough that this is now possible, and it is the entire point of splitting.
2. **Colour literals exist only in `tokens.css`.** Everything else uses `var(--…)`. The ~60
   existing offenders are converted as their file is moved, not in a separate pass — a mass
   find-and-replace across a 4 000-line file is exactly the change nobody can review.
3. **`@layer base, components, overrides;`** declared in `index.css`. Today the cascade is decided
   by *where in the file* a rule happens to sit, which is why "move a rule and something else
   changes" is possible at all. Layers make the order explicit and independent of position.

### Ordering is behaviour, not taste

The one genuine risk in this whole exercise: CSS depends on source order, so moving a rule can
change what wins. Mitigation, in order of importance:

- **Move one domain per step, verify, then move the next.** Never a big-bang reshuffle.
- **Preserve relative order inside a domain** when moving it — copy the blocks in the order they
  appear, do not tidy them on the way.
- **Layers first (phase 0), splitting second.** With `@layer` in place, an accidental order change
  between a base rule and a component rule can no longer flip a winner.
- The 15 deep selectors and 2 `!important`s are listed and checked by hand at the end.

---

## 5. The check that keeps it true (proposed lint C8)

Without this, phase 6 is "and then it grows back". `scripts/check-styles.mjs`, wired into
`npm run check` beside C1–C7:

- **no colour literal outside `src/styles/tokens.css`** — hex, `rgb(`, `hsl(`, named colours;
  `transparent` and `currentColor` excepted;
- **file size cap of 500 lines** per style file — the same instrument as C3, and the same reason:
  the number is not sacred, but hitting it forces a DECISION about whether a new domain has
  appeared;
- **`src/index.css` contains only `@import`, `@layer` and comments** — the moment it accepts one
  real rule it will accept the next thousand, which is precisely how `routes/api.ts` grew;
- **every file in `src/styles/` is imported by `index.css`** — a stylesheet nobody imports is dead
  code that still looks alive.

⚠️ Not proposed: a check that class prefixes match their file. It would need a real CSS parser and
would fight legitimate cross-domain rules (`.dash-pair > :only-child`). The naming convention is
already followed voluntarily; a check should be spent where discipline actually fails, which is
colour literals and file growth.

---

## 6. Phases

Each phase ends green (`npm run check` + `npm run build`) and is independently revertible.

| # | Phase | Notes |
|---|---|---|
| ~~0~~ | ✅ **DONE 2026-08-12 — 76 dead blocks removed** (4 258 → 4 182 lines) | See the note below on how it was verified, and on what deliberately stayed. |
| 0.5 | **Resolve the 8 conflicting duplicates** one at a time | §2.4. Each one changes rendering when collapsed, so each needs the owner's eye. Do NOT batch. |
| 1 | `@layer base, components, overrides` + move `:root`/theme blocks into `tokens.css` | Cascade becomes explicit BEFORE anything moves. Highest risk-reduction per line changed. |
| ~~2~~ | ✅ **DONE 2026-08-12 — split into nine parts** (`src/styles/*.css`), `index.css` is imports only | See §6.1. Boundaries are the file's OWN section banners, so the concatenation is byte-identical; Vite inlines the imports (one CSS asset in `dist`, zero `@import` left). |
| 3 | Extract `ui.css` (primitives) | Mirrors `components/ui/`. Everything downstream depends on these, so they move before domains. |
| 4 | Domains, ONE per step: landing → settings → planning → accounts → advisor → transactions → dashboard → stats | Landing first: it is self-contained and touches nothing else, so it is the honest rehearsal. Stats last: biggest and most entangled. |
| 5 | Move each domain's `@media` blocks next to their rules | Done per domain, during its own step in phase 4, not as a separate pass. |
| 6 | Convert the ~60 colour literals to tokens | Also per domain, during its own step. |
| ~~7~~ | ✅ **DONE — `scripts/check-styles.mjs` in `npm run check`** | Index is imports only, every part is imported, per-part line ceiling with two named exceptions. |

**Estimated size:** phases 0–3 are small. Phase 4 is the bulk — eight steps, mechanical but
requiring visual verification of each domain (which needs the owner, since live checking is their
routine per `CLAUDE.md` §Ops).

---

## 7. What this deliberately does NOT do

- **No visual change.** Not one. If a phase changes how anything looks, that is a bug in the move,
  not an improvement — restyling happens against `DESIGN.md`, separately, afterwards.
- **No renaming of classes.** The names are documented in `DESIGN.md` and watched by the
  `impeccable` hook. Renaming would fold a second, invisible change into a large diff.
- **No dead-rule sweep.** Tempting during a move and wrong to combine with it: proving a selector
  is unused needs runtime evidence, and a wrong guess deletes something that only appears in a
  state nobody tested. Worth its own task, after the split, when each file is small enough for the
  question to be answerable.

---

## 6.1 What the split actually did (2026-08-12)

Nine parts under `src/styles/`, `index.css` reduced to nine `@import` lines and a comment.

**The boundaries are the file's own section banners, not a domain map.** That is a deliberate
compromise and the reason the move could be made at all: cutting at existing boundaries keeps every
rule in its original position relative to every other, so the concatenation of the parts is
**byte-identical** to the file that shipped — which is what was asserted before writing anything to
disk. Regrouping rules by domain (phase 4) moves rules ACROSS those boundaries, changes which rule
wins, and therefore needs a visual check that only the owner can do.

So two parts are still large and honestly named for what they are rather than for a domain they do
not have: `domains-a.css` (1 156 lines) and `settings.css` (675). They carry named exceptions in
C8 — an exception is a debt with a name on it; a raised limit is a limit nobody believes.

**Verified:** the build emits ONE css asset with zero `@import` remaining, so the split costs
nothing at runtime.
