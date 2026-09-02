# STYLES.md — the client's style architecture

> **Current state.** The single 4 237-line `src/index.css` is GONE: it is **seventeen files under
> `src/styles/`**, `index.css` holds nothing but `@import` lines, and lint **C8** keeps it that way.
> Phase 0 (76 dead blocks) is done, and lint **C9** has since removed 59 more rules that matched no
> class. The build still emits ONE css asset with zero `@import` remaining, so the split costs
> nothing at runtime.
>
> **What is left needs the owner's EYE, not work:** phase 0.5 (eight quietly conflicting selectors)
> and phase 4 (true domain grouping). Both change rendering, which is why neither was batched into
> the split.
>
> **This is NOT the design system.** Tokens, patterns and the decision journal are in `DESIGN.md`,
> and that file stays the source of truth for how things should LOOK. This one is only about where
> the rules live and what stops them sprawling again.

---

## 1. What is still wrong

### 1.1 Eight selectors appear more than once with DIFFERENT bodies

These are not duplicates, they are accidental overrides:

```
.wd-col   → flex: 1; …; height: 100%
.wd-col   → min-width: 0; …        ← twelve lines later, no height, no flex
```

Neither wins outright. CSS merges them, so what actually renders is `flex: 1` and `height: 100%`
from the first plus everything from the second — a rule **nobody wrote and nobody can see**.
`.tx .amt`, `.runway-val`, `.runway-comment`, `.topbar-brand .name`, `.cat-card .cat-ico` and
`.corpus-doc` are in the same state.

**Why this is the most expensive item on the list.** Edit `.hb-row` and nothing happens, because a
copy further down wins. The edit is correct, the file is saved, the screen does not change.

⚠️ **The identical ones were safe to remove; these are not.** Deleting a block with a byte-identical
copy LATER cannot change rendering — the later one already won for every property it declares.
A conflicting one DOES change rendering when collapsed, because today's appearance is the accidental
merge. One decision per case, one visual check per case. **Do NOT batch.**

⚠️ **Duplicates INSIDE `@media` blocks were never touched.** The phase-0 pass matched only
top-level single-line rules; `@media (max-width: 720px) { .hb-grid … }` still exists five times.
Extending the same proof to nested rules is safe in principle but was not done, so it is not claimed.

### 1.2 Roughly 60 colour literals live outside the theme blocks

`#fff` appears 26 times below the token definitions, `#c9871a` seven times (that value is already
`--warn`), and a dozen more one-offs. Each is a small landmine for the dark theme, which is not a
variant here but an equal citizen — a hardcoded `#fff` is correct in one theme and wrong in the
other, and the wrongness shows up on someone else's screen, not on the author's.

The `DESIGN.md` review checklist asks reviewers to look for "local hardcoded colour". Asking a human
to notice one line in four thousand is not a check, it is a hope.

### 1.3 Orphaned media queries and duplicated blocks across files

Both are live bugs with cards in `ROADMAP.md` («Ідеї фіч → Стилі»): a `@media` rule that stayed
behind when its layout moved to a later-imported file loses silently (`@media` adds zero
specificity), and §WEEKDAY / §HABITS families are declared four to five times across `domains-a`,
`shell`, `topbar` and `domains-b`. The rules are identical today, so nothing is visible; they will
diverge silently, and the lower copy will win.

---

## 2. The ratchet that keeps it true

**The reason `worker/routes/api.ts` is not 3 331 lines any more is not that someone split it — it
is that C3 refuses to let it grow back.** The same applies here:

- **C8** — `index.css` is imports only, every part is imported, per-part line ceiling.
- **C9** — every `className` has a rule, and every rule has a `className`. It ran in both directions
  on its first day: forward it found five class names shipped with no rules at all; backward it
  found 59 dead rules.
- **An exception may never grow.** When a part overflows it gets a SEAM, not a raised cap:
  `settings.css` → `settings-shell.css` and later lost its exception entirely; `domains-a.css` →
  `analytics.css`, then `advisor.css`. The ratchet has held every time it fired.
- **`landing.css` is the one part that exists for a different reason:** the marketing page was
  living at the bottom of `topbar.css`, which owns the SIGNED-IN chrome. That split is about
  ownership, not size — and `landing.css` is the ONLY file where marketing rhythm is allowed.

⚠️ Not proposed: a check that class prefixes match their file. It would need a real CSS parser and
would fight legitimate cross-domain rules (`.dash-pair > :only-child`). The naming convention is
already followed voluntarily; a check should be spent where discipline actually fails.

---

## 3. Why the boundaries are where they are

The parts were cut at the ORIGINAL file's own section banners, not along a domain map. That is a
deliberate compromise and the reason the move could be made at all: cutting at existing boundaries
keeps every rule in its original position relative to every other, so the concatenation of the parts
was **byte-identical** to the file that shipped — which was asserted before anything was written to
disk.

**Phase 4 is the part that has not happened:** regrouping rules by domain moves them ACROSS those
boundaries, changes which rule wins, and therefore needs a visual check only the owner can do.
`@layer` was skipped for the same reason.

---

## 4. Options considered and rejected

### 4.1 Tailwind — rejected

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

### 4.2 Sass / SCSS — rejected

- The features actually wanted are **nesting** and **file splitting**. Native CSS now has nesting
  in every browser this app supports, and Vite inlines `@import` at build time. So Sass would buy
  a build dependency and a second language for something the platform already does.
- Variables are worse than what exists: Sass variables are compile-time, and this app switches
  themes at RUNTIME. Every colour must stay a custom property regardless.
- **When to revisit:** if loops or mixins ever become genuinely needed (e.g. generating a
  category-colour set programmatically). Right now the category palette is 14 hand-picked values
  that are meant to be hand-picked.

### 4.3 CSS Modules (`*.module.css`) — rejected, with regret

- The right idea (styles scoped to the component that owns them), but it hashes class names, and
  this project has three things that depend on the names being global and stable: the `impeccable`
  detector hook, `DESIGN.md`, which documents patterns BY CLASS NAME, and the theme system.
- It would also touch every `className` in every component — a diff of thousands of lines in which
  a real change is invisible.

### 4.4 CSS-in-JS — rejected outright

The CSP is `style-src 'self' 'unsafe-inline'` today only because React writes `style` attributes.
A runtime style injector adds a bundle cost and a per-render cost to solve a problem that is not
about runtime at all.

---

## 5. Ordering is behaviour, not taste

The one genuine risk in this whole exercise: CSS depends on source order, so moving a rule can
change what wins. Mitigation, in order of importance:

- **Move one domain per step, verify, then move the next.** Never a big-bang reshuffle.
- **Preserve relative order inside a domain** when moving it — copy the blocks in the order they
  appear, do not tidy them on the way.
- The 15 deep selectors and 2 `!important`s are listed and checked by hand at the end.

---

## 6. What this deliberately does NOT do

- **No visual change.** Not one. If a step changes how anything looks, that is a bug in the move,
  not an improvement — restyling happens against `DESIGN.md`, separately, afterwards.
- **No renaming of classes.** The names are documented in `DESIGN.md` and watched by the
  `impeccable` hook. Renaming would fold a second, invisible change into a large diff.
- **No dead-rule sweep by eye.** Proving a selector is unused needs runtime evidence, and a wrong
  guess deletes something that only appears in a state nobody tested. That is C9's job, and C9
  carries a third-party prefix list plus dynamically-derived prefixes precisely because **a
  dead-code check without those is a delete button with a plausible explanation attached.**
