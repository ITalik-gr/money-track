# Architecture — layering, checks, and what is left

> **Status: the structural refactor is CLOSED.** All six phases (0–5) landed between 2026-08-03
> and 2026-08-07. What survives here is the durable part: the target layering, the checks that
> keep it from decaying, what was deliberately left out, and the short tail that is still open.
>
> **The narrative** — the measured "before" state, the diagnosis, the duplication register with
> what each entry actually turned out to be, the phase-by-phase plan and the session log — was
> moved to `HISTORY.md` (§"Архів: ARCHITECTURE.md") on 2026-08-07. Read it when you need to know
> *why* something is shaped the way it is; you do not need it to work in the tree.
>
> Queue lives in `ROADMAP.md`. Invariants and "how things work today" live in `CLAUDE.md`.

---

## 1. Why this job existed (one paragraph)

The reported symptom was "the files are large". The actual defect was that `CLAUDE.md` said
"`routes/*` is transport, `lib/*` is logic" while `worker/routes/api.ts` held **179 raw SQL
queries** in 3 331 lines. That gap is where a whole bug class grows:

```
a query lives inline in a handler
   → nothing can import it
      → the next feature writes its own
         → "spending" now has two definitions
            → they drift silently (SQL is a string; tsc cannot see inside it)
```

The mechanism had already fired four times in production — §CUR-PLAN, §SUB-MONTH, §REFUND,
§SPLIT (all documented in `CLAUDE.md`). Splitting the file without moving the SQL would have been
cosmetics.

**Result:** `api.ts` no longer exists. 179 queries → `worker/repo/`, 138 routes → 16 files under
`routes/api/`, `ai.ts` 1 335 → 212 lines, the client's 86 hand-written response types → one
declaration each in `shared/api/`. Tests 23 → **232**. No behaviour changed except two bugs that
were found by the new tests and fixed deliberately, each with a re-recorded golden.

---

## 2. Target architecture (this is the current state, not a plan)

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

## 3. Checks that keep it from decaying

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
| C10 | one conversion target: `getStoredRates` only in `money.ts`, no `₴` literal outside Telegram | a screen mixing the reader's currency with the hryvnia — arithmetic that renders perfectly and is wrong by the exchange rate | `scripts/check-currency.mjs` |

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

## 4. Deliberately NOT done

- **No second AI provider, no second bank.** An abstraction with one implementation is speculation;
  a seam is cheap and pays for itself. Both seams exist (`json.ts`, `BankProvider`).
- **No `RequestContext`.** It would have to be threaded through every `lib/` signature — a large
  behaviour-risking diff for what turned out to be three call sites. Revisit if a second field
  ever needs the same treatment.
- **API shapes unchanged.** Renaming fields and dropping dead ones is separate work.
- **The client was not refactored** beyond what the type contract required. `src/pages/Stats.tsx`
  (1 379 lines) is untouched.

---

## 5. What is still open

The queue itself lives in `ROADMAP.md`; this is the short version with the reasoning that decided
the order.

1. **The last 3 inline queries in the route layer**, all in `telegram.ts` — down from 10 on
   2026-08-07. `import.ts` and `setup.ts` moved once `worker/test/integrations.test.ts` existed
   (11 scenarios), and `webhook.ts` once `ingest.test.ts` had grown to 11. The rule held
   throughout and is the reusable part: **no query moves before something can catch a mistake**,
   because a mistake on these paths shows up not as a red snapshot but as a transaction that
   silently never arrives.
   The bot is what is left, and it is the awkward one: its handlers are driven by an update
   payload rather than an HTTP route, and its output is a `fetch` to the Telegram API — so the
   harness needs a mocked `fetch` and a snapshot of the OUTGOING calls, which is where the
   keyboard those three queries build actually becomes observable.
2. **`src/pages/Stats.tsx`** (1 379 lines) — the largest file in the project.
3. **Re-run `/security-review`.** The perimeter moved with the code, and the 2026-07-26 audit closed
   holes in exactly the places that have now been relocated.

**Closed since this document was trimmed (2026-08-07):**

- **The `GET /transactions` over-fetch.** `SELECT t.*` shipped all 31 columns where `TxRow` names
  21. Now an explicit `FEED_COLUMNS` list — the response dropped **23% on the fixture** (52 562 →
  40 102 bytes over 50 rows) and more in production, where `raw_json` is a real bank payload rather
  than the fixture's empty one. The golden is the guard, because the type structurally cannot be.
- **An ingest event for an un-synced account is no longer lost** (§STUB-ACC in `CLAUDE.md`).
  `upsertMonoTx` mints a stub account instead of failing the foreign key, and `syncAccounts` fills
  it in — including for jars, whose upsert deliberately never overwrites a title, so the fill-in
  had to be `COALESCE` rather than a skip. Owner's decision, taken on the evidence of the
  characterization golden that recorded the loss.

---

## 6. Open-source checklist

> ⚠️ **The repository is already public** — `github.com/ITalik-gr/money-track`. Data hygiene was
> therefore done *first*, before the refactor, rather than last.

- [x] **`LICENSE`** — MIT, © Vitalii Hrytsenko, since 2026-07-27.
- [x] **`SECURITY.md`** (2026-08-03) — private reporting channel, scope, and the **deliberately
      accepted limits** (session revocation ≤60 s, raw error causes, per-isolate rate limiting, no
      backups) so they are not filed as findings.
- [x] **`CONTRIBUTING.md`** (2026-08-03) — the green bar, what each linter actually catches, and
      five non-negotiable rules with the price each one was bought at.
- [x] **Real figures from the live account removed** from the docs and — found on a second pass —
      from source too (`stats.ts`, `notify.ts`, `ai.ts`, `TxReimbursement.tsx`, migration 0030 and
      its generated embed). A third party's first name, attached to a money transfer, went with
      them. The lesson is preserved everywhere; only the number is gone.
- [x] **`HISTORY.md` verified to be in `.gitignore`** — the internal history was never published.
- [x] **`.dev.vars.example`** — checked 2026-08-07: no real values, and never was (`.dev.vars`
      itself has never been committed). Two gaps fixed: the three Telegram variables were missing
      entirely, and `APP_PASSWORD` still described itself as the login password although password
      login was removed in July — a stranger following the file would have configured a broken bot
      and set a variable that means something else now.
- [x] **Perimeter re-audit after the refactor** — done 2026-08-07, findings in `CLAUDE.md §Безпека`.
      The relocation itself introduced nothing: gates, headers, forwarding and the new `repo/`
      layer all hold. C7 was added so the one property the split relies on is machine-checked.
- [x] **Full git-history secret scan** — `gitleaks` over all branches, run by the owner
      2026-08-07: clean. (A pattern sweep for the known key shapes had already found nothing, but
      that was never equivalent — it only matches the shapes one thinks of.)
- [x] **Per-user quota on receipt uploads** — `lib/platform/quota.ts`, 60/day, counted in the
      user's own `app_state`. The last open item from the perimeter pass.

**Closed as owner's decisions (2026-08-03):** git history is not rewritten — the removed figures
stay in old commits, and a force-push on a public repo costs more than the partial gain, since
GitHub caches old objects anyway. The D1 `database_id` stays in `wrangler.jsonc`: removing it would
break the owner's own deploy, and it is not a secret on its own. Credit-card own funds stay
negative when the card is in debt.

---

## 7. Working language: English

**Everything newly written into this repository is English** — code comments and every Markdown
addition, *including a new section inside a document that is otherwise Ukrainian*. The rule is
about what gets written, not about what a file already holds. The repository is public, so the
audience is a stranger reading it cold.

Existing Ukrainian prose is not rewritten wholesale — there are thousands of lines and they carry
the "why it is like this" that a mass translation would flatten. It migrates when that text is
edited for another reason, so several documents stay mixed for a while; that is the accepted
transitional state. Unchanged either way: UI strings (they go through `t()`), model prompts, and
matching keys (`.includes("фоп")`, `/переказ|зняття/i`) — those are data, not prose.

**When the tail in §5 is empty, this file becomes a short section of `CLAUDE.md` and is deleted.**
