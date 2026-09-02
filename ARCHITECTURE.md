# ARCHITECTURE — layering and the checks that hold it

> **Status: the structural refactor is CLOSED** (phases 0–5, 2026-08-03 → 2026-08-07). `api.ts` no
> longer exists: 179 inline queries went to `worker/repo/`, 138 routes to 16 files under
> `routes/api/`, `ai.ts` 1 335 → 212 lines, and the client's 86 hand-written response types became
> one declaration each in `shared/api/`. Tests 23 → 232 (795 today).
>
> **Read this before a structural change or a new lint.** The narrative — the measured "before",
> the duplication register, the phase plan, the open-source checklist — is in `HISTORY.md`.
> Invariants → `docs/*.md`. Queue → `ROADMAP.md`.
>
> Why the job existed, in one sentence: `CLAUDE.md` claimed "`routes/*` is transport, `lib/*` is
> logic" while one route file held 179 raw SQL queries — and a query that lives inline cannot be
> imported, so the next feature writes its own, and "spending" quietly acquires two definitions.
> That mechanism had already fired four times in production (§CUR-PLAN, §SUB-MONTH, §REFUND, §SPLIT).

## 1. Target architecture (this is the current state, not a plan)

```
routes/     transport: parse, validate, choose a status code, serialise
   ↓        (a handler reads as 5–15 lines; NO .prepare())
services/   scenarios: orchestration, transactionality, permissions
   ↓
lib/        domain logic — the canon (lib/finance/stats.ts) lives here
   ↓
repo/       the only layer that issues SQL
```

**The rule that makes the rest possible:**

> `.prepare()` is allowed **only** in `repo/`. Violating it fails `npm run check`.

This is not style. It physically prevents "I'll just write my own query next to the handler" —
the move that produced §CUR-PLAN, §SUB-MONTH and §REFUND.

Three boundaries worth stating explicitly, because each was decided by doing:

- **A service NAMES its failures, the route WORDS them.** `services/reimbursements.ts` returns
  `errReimbCurrency`; the route turns that into a status code and a sentence via `st(locale, …)`.
  One place owns the rules, another owns the wording — so `services/` stays free of i18n and Hono.
- **Route files are grouped by FIRST PATH SEGMENT, not by concept.** `POST /transactions/:id/enrich`
  is conceptually AI work but lives in `transactions.ts`. One file owning a whole prefix is what
  makes "literal above parameterised" (`/transactions/frequent` before `/transactions/:id` — a real
  outage) checkable by reading one file instead of reasoning about mount order.
- **The AI provider seam is `lib/ai/json.ts`.** Everything above it is already provider-agnostic.
  `demoClamp` stayed Anthropic-only on purpose: the rule it encodes ("clamp where the `fetch`
  happens, not at the call site") is what makes it unforgettable, and provider-awareness needs a
  second provider to be aware *of*.

---

## 2. Checks that keep it from decaying

The principle — **"a check beats an instruction"** — had already paid for itself twice here (the
SQL linter, `numbersAreGrounded`). Each rule above now has a deterministic guard, and `npm run check`
runs all of them.

| # | Check | Catches | Where |
|---|---|---|---|
| C1 | `.prepare()` only in `repo/` | SQL creeping back into routes | `scripts/check-repo-layer.mjs` |
| C2 | no shapeless row types in `repo/`/`services/` | a response quietly losing a column | `scripts/check-api-contract.mjs` |
| C3 | line ceiling per file in `routes/`+`services/`+`lib/` | `api.ts` regrowing | `scripts/check-route-size.mjs` |
| C4 | client declares no API response types of its own | working around C2 | `scripts/check-api-contract.mjs` |
| C5 | golden `/analytics` responses match to the kopeck | silent money regressions | `worker/test/golden.test.ts` |
| C6 | golden DATABASE STATE after every write endpoint | silent regressions in writes, where the response says nothing | `worker/test/writes.test.ts` |
| C7 | no literal route below a parameterised one that matches it; one prefix, one file | an endpoint silently unreachable — a real past outage | `scripts/check-route-order.mjs` |
| C8 | `index.css` is imports only; every part imported; line ceiling per part | the 4 182-line stylesheet regrowing | `scripts/check-styles.mjs` |
| C9 | every `className` has a rule, every rule has a `className` | a block shipping unstyled, and dead CSS reading as live | `scripts/check-styles-used.mjs` |
| C10 | one conversion target: `getStoredRates` only in `money.ts`, no `₴` literal in the worker (the Telegram exemption was dropped 2026-08-21) | a screen mixing the reader's currency with the hryvnia — arithmetic that renders perfectly and is wrong by the exchange rate | `scripts/check-currency.mjs` |

Two things learned about the checks themselves:

- **C1 reached zero and is now a flat ban** (2026-08-08). It spent its life as a two-directional
  ratchet — a budget per file that could only fall, failing the build if a drop was not written
  down — because the alternative was one enormous commit moving 179 queries, which is the shape of
  change that hides a regression. The ratchet was the migration mechanism, not the goal; with the
  budget map empty, a route that wants SQL now has to ADD a line to it, and adding one is the
  review conversation the map existed to force.
  The rule that governed every step of it, and the reason `telegram.ts` was last: **no query moves
  before something can catch a mistake.** Its handlers are driven by an update payload rather than
  an HTTP route and they answer over `fetch`, so nothing could observe them until
  `worker/test/telegram.test.ts` began recording the bot's outgoing calls.
- C3 deliberately is NOT a ratchet. A query count moves in whole steps and rarely, so a drop means
  someone forgot to tighten the budget. Line counts move on every edit, and a check that goes red
  because a file got three lines shorter trains people to edit the budget without reading it. C3
  fails only when the slack exceeds 80 lines.
- **A check earns its keep by forcing a DECISION, not by catching a bug.** C3 paid for itself the
  hour it landed: adding `/analytics/weekday` pushed `routes/api/analytics.ts` over its allowance,
  and instead of raising the number the net-worth reconstruction moved to `lib/finance/networth.ts`
  — which is where reconstruction belonged anyway.
- **C9 is the first check bought by bugs the OWNER found, not by ones a review found** (2026-08-14).
  Three in one day, all the same shape: `BankConnectionsCard` used `set-card` without `card` and
  had no background; the category page shipped `cat-page-stats`, `cat-page-dot`,
  `cat-page-children`, `cat-chip` and `cat-merch-list` with no rules at all. **A class name that
  matches nothing is indistinguishable from one that matches something** — the join between a
  component and a stylesheet exists only in a browser, so neither `tsc` nor a CSS parser can see
  it, and a reviewer sees two plausible strings.
  It ran in both directions on the first day and that is what made it worth writing: the reverse
  direction found 59 dead rules — `.advisor-ask*` is seven rules for a feature that no longer
  exists, `.drill-tx*` and `.chat-log` are a superseded naming generation — and removing them took
  `domains-a.css` under its C8 exception and let `settings.css` drop its exception entirely.
- **C10 exists because §BASE-CUR works by NOT touching its call sites** (2026-08-18). The display
  currency shipped by changing what `getRates` returns while leaving its name and its type alone,
  so forty existing call sites started converting into the reader's currency without being edited.
  That is what made the change tractable in one pass — and it is exactly what makes a regression
  invisible: a caller that reaches for the raw table instead compiles, runs, and renders a
  plausible number that is wrong by the exchange rate. `tsc` cannot tell two
  `Record<string, number>` maps apart, so the check is the only thing that can.
  ⚠️ **The false positives are the whole design problem, and both kinds nearly caused damage.**
  Six `.recharts-*` rules are emitted by the library at runtime and looked exactly as dead as the
  rest; deleting them would have broken every chart. And `` `toast-${t.type}` `` produces class
  names that appear nowhere as literals. So the check carries a third-party prefix list and derives
  dynamic prefixes from the source itself. **A dead-code check without those is a delete button
  with a plausible explanation attached** — and a check that reports one false positive is a check
  that gets switched off.
  It also found a live bug on its way in: `.acct-card.editing` was written for a card whose class
  is `acct2`, so "the account editor takes the full row" was shipped, listed as done, and never
  once worked.
- **C7 exists because the split made a claim that nobody could keep by hand.** "One file owns a
  whole prefix, so route ordering is checkable by reading one file" is true and useless if the
  reading never happens. It found nothing on the day it landed — which is the answer the security
  pass needed, and now it is an answer that stays true without being re-derived.

**Re-recording a golden** (`UPDATE_GOLDEN=1 npm test`) is only for a deliberate, explained
behaviour change. A red test is never "fixed" by re-recording — and the two fixture defects found
during the refactor both mattered precisely because they trained the opposite habit.

---

## 3. Deliberately NOT done

- **No second AI provider, no second bank.** An abstraction with one implementation is speculation;
  a seam is cheap and pays for itself. Both seams exist (`json.ts`, `BankProvider`).
- **No `RequestContext`.** It would have to be threaded through every `lib/` signature — a large
  behaviour-risking diff for what turned out to be three call sites. Revisit if a second field
  ever needs the same treatment.
- **API shapes unchanged.** Renaming fields and dropping dead ones is separate work.
- **The client was not refactored** beyond what the type contract required. `src/pages/Stats.tsx`
  (1 379 lines) is untouched.


---

## 4. What is still open

The queue itself lives in `ROADMAP.md` («Архітектурне / потребує рішення»). Three items, with the
reasoning that decided their order:

1. **The last 3 inline queries in the route layer**, all in `telegram.ts` — down from 10. The rule
   that governed every step of the migration is the reusable part: **no query moves before
   something can catch a mistake**, because a mistake on these paths shows up not as a red snapshot
   but as a transaction that silently never arrives. The bot is the awkward one: its handlers are
   driven by an update payload rather than an HTTP route, and its output is a `fetch` to the
   Telegram API, so the harness needs a mocked `fetch` and a snapshot of the OUTGOING calls.
2. **`src/pages/Stats.tsx`** — the shell was extracted and the tabs live in `components/stats/`;
   the size is what remains.
3. **Re-run `/security-review`.** The perimeter moved with the code.

**Working language: English.** Everything newly written into this repository — code comments and
every Markdown addition, including inside a document that is otherwise Ukrainian. Existing
Ukrainian prose is not rewritten wholesale; it migrates when that text is edited for another
reason. UI strings, model prompts and matching keys are data, not prose, and are exempt.
