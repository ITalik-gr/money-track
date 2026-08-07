# Architecture — structural refactor, in progress

> **Scope.** This is the working document for ONE job: get the codebase to a state where one
> number has one home in the code, and make the project fit to be read by strangers.
> It does not replace `CLAUDE.md` (invariants and "how things work today"). When the refactor
> closes, the durable rules move into `CLAUDE.md`, the journal into `HISTORY.md`, and this file
> is deleted. The task queue stays in `ROADMAP.md`.
>
> Created 2026-08-03. Measurements taken at commit `ff9816f`.

## Decisions taken at the start

1. **Characterization tests first, code movement second.** No query moves without a golden fixture
   behind it.
2. **Strictly behaviour-preserving.** Numbers and response shapes do not change. Bugs found along
   the way become separate cards in `ROADMAP.md` and are fixed *afterwards*, visibly.
3. **Providers: seams only.** No second bank and no second AI provider in this pass.
4. **A `services/` layer will be introduced** (phase 3). Transactional scenarios — reimbursements,
   splits — currently live in route handlers, and they are what the layer is for.
5. **Shared types are hand-written, not generated.** Generation adds a build step and an opaque
   artifact to a public repo, and it is not where the safety comes from: the guarantee is that
   the worker *types its return values* with the shared types, so `tsc` catches drift by itself.
6. **Credit-card own funds stay negative** when the card is in debt (owner's call, 2026-08-03).
7. **Git history is not rewritten**; the D1 `database_id` stays in `wrangler.jsonc` (owner's call).

---

## 1. Measured state

| Metric | Value |
|---|---|
| Total code | **32 252 lines** (16 019 worker · 15 811 client · 422 shared) |
| `worker/routes/api.ts` | **3 331 lines · 179 `.prepare()` · 129 routes · 26 domains** → **0 queries** (2026-08-05), then **deleted** (2026-08-07): 16 files under `routes/api/`, largest 769 |
| `src/store/api.ts` | 1 287 lines · **86 hand-written response types** |
| `shared/types.ts` | 142 lines · 13 types · **0 imports from the worker** |
| `src/pages/Stats.tsx` | 1 375 lines |
| `worker/lib/ai/ai.ts` | 1 335 lines · **6 distinct responsibilities** |
| `worker/lib/ai/advisor.ts` | 1 088 lines · 38 `.prepare()` · 7 `getRates()` calls |
| Tests at start | **376 lines** against 32 252 lines of code |
| Route shadowing (literal after param) | **clean** ✅ |

### `api.ts` fragmentation

The file grew by appending, so routes of one domain sit in scattered islands:

| Domain | Routes | Islands |
|---|---|---|
| `transactions` | 14 | **5** |
| `analytics` | 19 | **4** |
| `planned` | 10 | **3** |
| `accounts` | 10 | **3** |

`/accounts` is declared at L62, `/accounts/manual` at **L3188**. That is not an aesthetic problem:
to change a domain's behaviour you must first find all of its islands, and it is precisely at that
step that someone writes a second query instead.

---

## 2. Diagnosis

The reported symptom was "the files are large and unwieldy". Splitting 3 331 lines into 26 domain
files would fix nothing on its own — the 179 queries would simply move along with the routes.

**The root defect:** `CLAUDE.md` states "`routes/*` is transport and validation; `lib/*` is
logic", while `api.ts` holds **179 raw SQL queries**. The project violates its own written rule,
and that is where the whole bug class grows from:

```
a query lives inline in a handler
   → nothing can import it
      → the next feature writes its own
         → "spending" now has two definitions
            → they drift silently (SQL is a string; tsc cannot see inside it)
```

This is not a hypothesis. The mechanism has fired **four times**, all documented in `CLAUDE.md`:

| Incident | What happened |
|---|---|
| **§CUR-PLAN** | five places summed `period_amount` raw — a $5 subscription weighed 5 ₴ |
| **§SUB-MONTH** | sums never normalised the period — **two different totals for the same subscriptions on screen** |
| **§REFUND** | `INCOME_WHERE` was just `amount > 0` — income overstated on real data |
| **§SPLIT** | a canonical helper used without `STATS_JOINS` — Statistics silently went blank |

---

## 3. Duplication register

### 🔴 D1. "Own funds = balance − credit_limit" — **six implementations that disagree**

`CLAUDE.md` calls this invariant unbreakable and names `fundsBreakdown()` the single source. In
reality:

| # | Location | Formula |
|---|---|---|
| 1 | `lib/ai/advisor.ts:64` (the claimed canon) | `balance − credit_limit` |
| 2 | `lib/finance/finance.ts:155` | `balance − creditLimit` |
| 3 | `routes/api.ts:1612` | `balance − credit_limit` |
| 4 | `routes/api.ts:1657` | `hb − credit_limit` |
| 5 | `lib/messaging/notify.ts:316` | `credit_limit − balance` — **inverted** |
| 6 | `src/pages/Accounts.tsx:31` (**client!**) | clamped: `Math.max(own, 0)` |

The disagreement was real, not theoretical: the client clamped negative values to zero while the
server did not, so **the Accounts page total did not match the cushion on the dashboard**.

→ ✅ **Client half fixed 2026-08-03** (clamp removed, logged in `DESIGN.md`). The remaining five
server-side copies collapse into one `ownFundsMinor()` in phase 4.

### 🟠 D2. There is no client↔worker contract

`shared/types.ts` is imported by **zero** worker files. The "shared" types are shared in name
only: the client hand-declares 86 types describing what the server returns, the worker declares
its own inline via `.all<{...}>()`, and `tsc` sees two independent truths it cannot reconcile.
Drift surfaces only in production. Second in importance after the SQL.

### 🟠 D3. `ai.ts` carries six responsibilities

| Layer | Contents | Provider-specific? |
|---|---|---|
| L1 transport | `callHaiku`, `callMessagesRaw`, `runToolConversation`, `demoClamp`, `webSearchTool` | **yes** |
| L2 cost accounting | `PRICES`, `priceFor`, `callCostUsd`, `recordUsage`, `readUsageStats` | **yes** |
| L3 model routing | `MODEL_*`, `AI_TASK_DEFAULTS`, `getTaskModel` | **yes** |
| L4 JSON hardening | `extractBalanced`, `repairTruncatedJson`, `callHaikuJson` | no |
| L5 prompts/persona | `FEW_SHOT`, `CACHE_GUIDE`, `buildSystemPrefix`, `replyLangDirective` | no |
| L6 **feature logic** | `enrichTransaction`, `generateAdvice`, `generateFinancialReport`, `txChat`, … | no |

L6 is the anomaly: `generateFinancialReport` lives in `ai.ts` even though `report.ts` exists as
its own 332-line file — same for `generateInsight` ↔ `insight.ts`. No rule decides which goes
where, so features are smeared across two files.

**The provider seam runs exactly between L3 and L4.** Everything above L4 is already
provider-agnostic and needs no changes at all.

### 🟡 D4. The `period_mode` default is written three times

`api.ts:1376`, `:1707`, `:1927` each do `getState(...) || "calendar"`. A two-line
`getPeriodMode(env)` removes it.

### 🟡 D5. `getRates()` is called 7 times inside `advisor.ts`

Lines 60, 90, 167, 591, 654, 802, 980 — seven separate reads. Beyond the waste, different parts of
one response could in principle rest on different rate snapshots.

### 🟢 D6. What already works — leave alone

- **`stats.ts` is a genuine canon.** `SPEND_WHERE` / `EFF_*` / `STATS_JOINS` / `amountSum` are
  exactly the pattern to spread; it was also the only tested part of the codebase.
- **`scripts/check-stats-sql.mjs`** — a working example of "a check beats an instruction".
- **The bank registry** (`BankProvider` + `providers/`) — the seam is already cut correctly.
- **`AppDb`** (`lib/platform/db-shim.ts`) — a narrow database facade with two implementations.
  This turned out to be the single most valuable thing in the codebase for testability (see §6).
- **Client `ui/` primitives know nothing about data** — 0 of 38 data-fetching files live there.
- **Route ordering is clean** — literals are declared above parameterised routes.

---

## 4. Target architecture

```
routes/     transport: parse, validate, choose a status code, serialise
   ↓        (a handler should read as 5–15 lines; NO .prepare())
services/   scenarios: orchestration, transactionality, permissions
   ↓
lib/        domain logic — the canon (lib/finance/stats.ts) lives here
   ↓
repo/       the only layer that issues SQL
```

**The rule that makes the rest possible:**

> `.prepare()` is allowed **only** in `repo/`. Violating it fails `npm run check`.

This is not style. It is what physically prevents "I'll just write my own query next to the
handler" — the move that produced §CUR-PLAN, §SUB-MONTH and §REFUND.

`RequestContext` (phase 4) carries `rates`, `locale`, `period_mode` and `isOwner`, loaded once per
request. It closes D4 and D5 together.

### Provider seams (seams only — no new implementations)

- **AI:** an interface with a single-shot `complete()` plus capability flags (`toolUse`,
  `promptCache`, `webSearch`, `pdf`). `demoClamp` becomes provider-aware — today it only knows
  Anthropic models, so a foreign provider in the demo would slip past the spend ceiling.
- **Banks:** normalisation stays strictly inside the provider; monobank specifics
  (`upsertMonoTx`, `descriptionIsTransfer`) stop protruding into shared paths.

---

## 5. Checks that keep it from decaying

The project already derived the principle — **"a check beats an instruction"** — and it has paid
off twice (the SQL linter, `numbersAreGrounded`). Each rule in §4 gets a deterministic guard.

| # | Check | Catches | Status |
|---|---|---|---|
| C1 | `.prepare()` only in `repo/` | SQL creeping back into routes | ✅ `scripts/check-repo-layer.mjs` |
| C2 | route response types imported from `shared/` | client↔server contract drift | phase 2 |
| C3 | line ceiling per route/service file | `api.ts` regrowing | ✅ `scripts/check-route-size.mjs` |
| C4 | client declares no API response types of its own | working around C2 | phase 2 |
| C5 | golden `/analytics` responses match to the kopeck | silent money regressions | ✅ `worker/test/golden.test.ts` |
| C6 | golden DATABASE STATE after every write endpoint | silent regressions in writes, where the response says nothing | ✅ `worker/test/writes.test.ts` |

---

## 6. Plan, by phase

### Phase 0 — safety net ✅ DONE 2026-08-03

`worker/test/` — harness, fixture, and 36 golden snapshots. Tests went **23 → 59**. No production
code was changed.

- **`harness.ts`** is a third implementation of the existing `AppDb` (after real D1 and DO-SQLite),
  this one over `node:sqlite`. That is why the golden tests exercise **the same SQL** production
  does rather than a copy of it. The schema is built from the real `migrations/*.sql` — all 37 run
  under `node:sqlite`, producing 29 tables. A fixture schema that drifts from the real one goes
  green exactly when a migration has broken something.
- **Time is frozen by overriding `Date.now`.** `stats.ts` already accepts `now` as a defaulted
  parameter, so determinism required **no production change at all** — which matters, because
  these tests exist to prove the refactor changed nothing and so must not depend on it. The
  instant is 14 May 2026, 12:00 Kyiv: mid-week, mid-month, mid-day, so no boundary hides an
  off-by-one.
- **The fixture covers exactly what has broken before:** §SPLIT, §REFUND (both directions — a
  refund, and a P2P that must *not* be treated as one), §COMPENSATION (full and partial), a paired
  transfer, bucket 13, `real_category_id`, sub-category roll-up, holds, USD/EUR, §CUR-PLAN,
  §SUB-MONTH (monthly/quarterly/weekly plans), a §6 importance override, a credit card in debt.
  History runs eight complete months back, because `categoryMonthlyLevels` only looks at complete
  months.

**Proof the tests are not vacuous** (a test that is always green is worse than none) — two
deliberate mutations of the canon:

| Mutation | Failed |
|---|---|
| `EFF_AMOUNT` stops accounting for `reimbursed` | **12 / 36** |
| `SPEND_WHERE` stops excluding bucket 13 | **11 / 36** |

Re-recording: `UPDATE_GOLDEN=1 npm test` — only for a deliberate, explained behaviour change. A
red test is never "fixed" by re-recording.

### Phase 1 — repository layer + C1 ✅ `api.ts` DONE 2026-08-05

Moving the 179 queries into `worker/repo/` **without changing the SQL text** (a copy, not a
rewrite — rewriting changes behaviour).

**`api.ts` is at 0 inline queries, down from 179.** Its line is deleted from the budget map in
`check-repo-layer.mjs`, so the file is now under the flat ban rather than a ratchet: a route can
no longer *reach* for SQL at all. Golden tests green after every batch, 23 → **169**.

Ten queries remain in the route layer, in files that were never part of batches A–E:
`import.ts` 3, `telegram.ts` 3, `setup.ts` 2, `webhook.ts` 2. Those are the ingest and
integration paths and they have **no characterization coverage of any kind** — see "Next session
starts here".

**Milestone (2026-08-04): the canon no longer appears in the route layer at all.** `STATS_JOINS`,
`SPEND_WHERE` and `amountSum` are gone from `api.ts`'s imports — `tsc` reported each one
unprompted as it fell out of use. That is the actual goal of phase 1 stated precisely: a route can
no longer *reach* the fragments it would need to write its own definition of spending. What
remains imported from `stats.ts` is JS-side canon (period bounds, category levels, projections),
which routes are meant to call.

| Module | Covers |
|---|---|
| `repo/accounts.ts` | active / archived lists, net-worth columns, balance history |
| `repo/categories.ts` | the category tree |
| `repo/transactions.ts` | the feed, with its 10-parameter filter builder |
| `repo/goals.ts` | goals and contributions, including the partial-update builder |
| `repo/planning.ts` | active plans in three shapes, as raw rows for the schedule helpers |
| `repo/receipts.ts` | OCR line items: top items, window metadata, price points |
| `repo/analytics.ts` | period totals, series, all five breakdowns, monthly history, month-to-date, capital and net-worth reconstruction, single-merchant, period comparison, income, sparklines |
| `repo/budgets.ts` | envelope limits — list, monthly map, replace, clear, batch apply |
| `repo/events.ts` | event groups with ₴ totals, their transactions, and plan line items |
| `repo/reports.ts` | stored AI reports: list without payload, one with it, delete |
| `repo/knowledge.ts` | corpus notes and overrides of built-in docs |
| `repo/state.ts` | `app_state` rates, and the schema introspection the backup export reads |

### Remaining work, batch by batch

The 129 survivors sit in **54 handlers**. Line numbers are as of the current working tree and will
drift as batches land — re-derive them with:

```
node -e 'const s=require("fs").readFileSync("worker/routes/api.ts","utf8").split("\n");let c="(top)",L=0,n=0,o=[];s.forEach((l,i)=>{if(/^\s*(\/\/|\*|\/\*)/.test(l))return;const m=l.match(/^\s*api\.(get|post|put|patch|delete)\(\s*"([^"]+)"/);if(m){if(n)o.push([L,c,n]);c=m[1].toUpperCase()+" "+m[2];L=i+1;n=0}n+=(l.match(/\.prepare\(/g)||[]).length});if(n)o.push([L,c,n]);console.log(o.map(([l,r,q])=>`${l}\t${q}\t${r}`).join("\n"))'
```

Batches are ordered by **falling risk, not by size**. `/analytics` goes first because it is the
only region the golden snapshots cover end-to-end; the CRUD tail goes last because it is the
region where a mistake is caught by types rather than by a fixture.

| # | Batch | Handlers | Queries | Target module | Covered by golden? |
|---|---|---|---|---|---|
| ~~**A**~~ | ~~**`/analytics` tail** — `patterns` 2, `category` 6, `slice` 2, `health` 2~~ | 4 | **12** ✅ | `repo/analytics.ts` | ✅ fully |
| ~~**B**~~ | ~~**transactions + splits + reimbursements** — B1 reads 15, B2 writes 32~~ | 19 | **47** ✅ | `repo/transactions.ts` | ✅ reads by golden, writes by the new write suite |
| ~~**C**~~ | ~~**categories** — create, patch, usage, and `DELETE /categories/:id` alone at **15**~~ | 4 | **21** ✅ | `repo/categories.ts` | ✅ 16 new write scenarios |
| ~~**D**~~ | ~~**planning surface** — budgets 7, reports 3, planned 9, events 11~~ | 18 | **30** ✅ | `repo/planning.ts`, new `repo/{budgets,events,reports}.ts` | ✅ 28 write scenarios + 4 new read goldens |
| ~~**E**~~ | ~~**accounts CRUD + odds** — manual accounts 4, title/meta/active 3, delete 3, rates 2, export 4, knowledge 3~~ | 15 | **19** ✅ | `repo/accounts.ts`, new `repo/{knowledge,state}.ts` | ✅ 28 new write scenarios |

**Order of operations inside every batch** (this is what has kept the snapshots green so far):

1. Copy the SQL text **verbatim** into the repo module. Do not reformat, do not "improve" a join,
   do not rename a column alias — the point of the batch is that behaviour cannot have changed.
2. Give the function a name that says what it *returns*, not what the route does with it
   (`spendByCategory`, not `getOverviewData`) — reuse across routes is the whole reason for the
   layer, and a route-shaped name blocks it.
3. Run `npm test`. A moved query that changes a snapshot has not been moved; it has been rewritten.
4. Lower the `api.ts` budget in `scripts/check-repo-layer.mjs` to the new count in the **same**
   commit. The ratchet fails the build if you forget, which is the intent.
5. Note any duplicate or divergence found in §"What the layer has already surfaced" or as a card
   in `ROADMAP.md` — **do not fix it in the batch** (decision 2 at the top of this file).

**Per-batch cautions, known in advance:**

- **A — `/analytics/category` (6 queries)** is the last handler still assembling its own canon
  fragments; check each against `stats.ts` helpers before moving, and if one restates the canon
  locally, move it *as is* and file a card. That is exactly how the `/analytics/income` bug
  surfaced.
- **B — `PATCH /transactions/:id` (9 queries)** is a scenario, not a query: it touches transfers,
  `name_locked`, splits and reimbursements in sequence. Move the individual statements to `repo/`
  now and leave the orchestration in the handler; it becomes the first candidate for `services/`
  in phase 3. Splitting it twice is cheaper than getting the transaction boundary wrong once.
- **C — `DELETE /categories/:id` (15 queries)** is the single densest handler left, and it is a
  cascade: children, transactions, budgets, rules, aliases, splits. Same treatment as B — statements
  down, orchestration stays. Write down the deletion *order* while moving it; the order is the
  behaviour, and nothing in the type system records it.
- **E** has no golden coverage at all. These are write paths on accounts. Keep the diffs small and
  lean on `tsc` — or add characterization tests first if a handler looks non-obvious.

**Expected end state of phase 1:** `BUDGET["api.ts"] === 0`, the line deleted from the budget map,
and `check-repo-layer.mjs` reporting "no inline SQL in worker/routes". `api.ts` will still be ~2 000
lines of handlers at that point — cutting it into domain files is phase 3, and it is deliberately
*not* mixed into this one.

### What the layer has already surfaced

**Four real consolidations**, none of which was visible while the queries sat inline:

| Duplicate | Found in |
|---|---|
| balance history — *verbatim* copy | `/accounts/history` + `/analytics/networth` |
| spend/income totals — byte-identical at empty `curFilter` | `/analytics/compare` + `/analytics/forecast` |
| spend by category — semantically identical | `/analytics/overview` + `/analytics/by-category` |
| active plans with category | `/planned/upcoming` + `/analytics/cashflow-calendar` + forecast |

The by-category case is the strongest evidence the method works: the two queries were merged and
**the golden snapshot did not move**, which is what proves they were genuinely the same query
rather than merely similar.

**A real bug, found by the fixture rather than by eye** — see the card in `ROADMAP.md`.
`/analytics/income` builds its own `SUM(t.amount)` for the per-source breakdown while the total
uses canonical `incomeSum` (`EFF_INCOME`, which subtracts `reimburses_total`). A partly allocated
reimbursement therefore lands in full in its category row but only as a remainder in the total.
On the fixture: total 47 700 ₴ against 48 700 ₴ of sources, **percentages summing to 102%**. It is
carried over unchanged — fixing it is a behaviour change and so its own card — with a comment at
the query so nobody "tidies" it into a silent one. This is exactly the §CUR-PLAN mechanism: a
local re-statement of the canon, drifting quietly.

**`noUnusedLocals` became a progress meter.** `SPEND_COUNT`, then `spendSum`, then `incomeSum`
each fell out of `api.ts`'s imports and `tsc` said so unprompted — the canon is genuinely leaving
the route layer rather than being re-aliased there.

**One near-duplicate is deliberately preserved.** `spendIncomeTotals`/`compareByCategory` differ
from `periodTotals`/`spendByCategory` only by not selecting a count. Merging them would add a
column to a response — a behaviour change, and therefore phase-4 work. They sit next to each
other in the module precisely so the decision is visible when that phase arrives.

**C1 ships as a ratchet, not a flat ban.** A flat ban would have to land as one enormous commit —
precisely the shape of change that hides a regression. So `scripts/check-repo-layer.mjs` holds a
per-file ceiling that may never rise, and *also* fails when the real count drops below the budget
without the budget being lowered. That keeps a stale allowance from quietly permitting new debt.
Verified to fail in both directions.

### Phase 2 — the type contract + C2/C4
`shared/` becomes the real source; the worker types its returns with it; the client's 86
hand-written types become imports.

### Phase 3 — split `api.ts` + introduce `services/` + C3 ✅ DONE 2026-08-07

138 routes → **16 domain files** under `worker/routes/api/`, grouped by FIRST PATH SEGMENT.
`index.ts` is a 66-line mount table that declares no route of its own; `api.ts` no longer exists.

- **Grouping by path prefix, not by concept.** `POST /transactions/:id/enrich` is conceptually
  AI enrichment, but it lives in `transactions.ts` with the rest of its prefix. One file owning a
  whole prefix is what makes the literal-before-parameterised rule (`/transactions/frequent` above
  `/transactions/:id` — a real outage) checkable by reading a single file, instead of depending on
  the order sub-apps happen to be mounted in. No two modules compete for a path, so the mount
  order in `index.ts` is inert by construction.
- **The parent owns the locale middleware.** Hono runs parent middleware for mounted sub-apps, so
  `ownerLocale` is still resolved exactly once per request.
- **`services/` took the three sequence handlers**, the ones already carrying a comment saying
  their order matters: `PATCH /transactions/:id` (tags → row → §R2-TX4 cleanup → alias learning),
  `PUT /transactions/:id/reimbursement` (the §COMPENSATION recalculation batch), and the category
  delete cascade. Plain CRUD stayed in `routes/` and calls `repo/` directly — a service per table
  would be ceremony. `PATCH /transactions/:id` is **6 lines** now.
- **The layer boundary that made this work:** a service takes parsed input and returns a RESULT.
  It never reads the request, picks a status code, or builds a user-facing string. So the
  reimbursement service NAMES its failures (`errReimbCurrency`, `errReimbSourceExceeded` + params)
  and the route words them through `st(locale, …)`. One place owns the rules, another the wording
  — and `services/` stays free of i18n and of Hono.
- **`normImportance` moved to `lib/finance/importance.ts`.** A service cannot import from
  `routes/`, and both layers normalise it. Small, but it is the layering rule doing actual work.
- **C1 was extended before anything moved.** `check-repo-layer.mjs` read `worker/routes`
  non-recursively, so every `routes/api/*.ts` file would have been free to carry SQL again while
  the check kept printing a tick. It now walks sub-directories and also covers `worker/services/`
  with **no budget** — that directory was created after the ban, so it has no debt to ratchet down.
- **C3 (`scripts/check-route-size.mjs`)**: 400 lines per file under `routes/` and `services/`, two
  recorded exceptions (`api/analytics.ts`, `telegram.ts`) that may never rise. Deliberately NOT a
  strict two-directional ratchet like C1: a query count moves in whole steps and rarely, so a drop
  means someone forgot to tighten it; line counts move on every edit, and a check that fails
  because a file got three lines shorter trains people to edit the budget without reading it.
  It fails only when the slack exceeds 80 lines. Verified to fail on an over-cap probe.

Tests stayed at **169 green** throughout — the point of doing this after phase 1 was that with
zero queries left in the route layer, moving a handler moves transport code only.

### Phase 4 — consolidate the duplicates
D1 (own funds), D4 (`period_mode`), D5 (`RequestContext`).

### Phase 5 — layer `ai.ts`
Separate L1–L6, cut the provider seam between L3 and L4, make `demoClamp` provider-aware.

---

## 7. Explicitly NOT in this pass

- **Bugs are not fixed inline.** Every divergence found becomes a card in `ROADMAP.md`. Otherwise
  the golden tests lose their meaning — every diff would need a manual verdict on whether it was
  a regression or an intended change.
- **No second AI provider, no second bank.** An abstraction with one implementation is
  speculation; a seam is cheap and pays for itself.
- **API shapes are not changed.** Renaming fields and removing dead ones comes later.
- **The client is not refactored deeply.** `Stats.tsx` (1 375 lines) and `src/store/api.ts` are
  touched only as far as phase 2 requires.

---

## 8. Open-source checklist

> ⚠️ **The repository is already public** — `github.com/ITalik-gr/money-track`. Data hygiene was
> therefore done *first*, before the refactor, rather than last.

- [x] **`LICENSE`** — present (MIT, © Vitalii Hrytsenko, since 2026-07-27).
- [x] **`SECURITY.md`** — created 2026-08-03: private reporting channel, scope, and the
      **deliberately accepted limits** (session revocation ≤60 s, raw error causes, per-isolate
      rate limiting, no backups) so they are not filed as findings.
- [x] **`CONTRIBUTING.md`** — created 2026-08-03: the green bar, what each linter actually catches,
      and five non-negotiable rules with the price each one was bought at.
- [x] **Real figures from the live account removed** from `CLAUDE.md`, `DESIGN.md`, `README.md`,
      and — found on a second pass — from **source too**: `stats.ts`, `stats.test.ts`, `notify.ts`,
      `ai.ts`, `TxReimbursement.tsx`, migration 0030 and its generated embed. A third party's
      first name, attached to a money transfer, was removed with them. The lesson is preserved
      everywhere; only the number is gone.
- [x] **`HISTORY.md` verified to be in `.gitignore`** — 153 KB of internal history was never
      published.
- [ ] **Full git-history secret scan** (`gitleaks`/`trufflehog`, all branches). `git log -S` is
      not proof — it matches one pattern out of many.
- [ ] **`.dev.vars.example`** — verify it is complete and holds no real values.
- [ ] **Re-run `/security-review`** after the refactor: the perimeter moves with the code, and the
      2026-07-26 audit closed holes in exactly the places now being relocated.

**Closed as owner's decisions (2026-08-03):** git history is not rewritten (the removed figures
stay in old commits; the cost of a force-push on a public repo outweighs a partial gain, as GitHub
caches old objects anyway). The D1 `database_id` stays in `wrangler.jsonc` — removing it would
break the owner's own deploy, and it is not a secret on its own.

---

## 9. Working language: English

**New code comments and new/edited Markdown docs are written in English.** The repository is
public, so the audience is a stranger reading it cold. Existing Ukrainian comments are not
rewritten wholesale — there are thousands of them and they carry the "why it is like this" that a
mass translation would flatten — they migrate when the surrounding file is edited for another
reason. Unchanged either way: UI strings (they go through `t()`), model prompts, and matching keys
(`.includes("фоп")`, `/переказ|зняття/i`) — those are data, not prose.

`CLAUDE.md §Робочий процес` states the same rule; this file follows it.

---

## 10. Session log

One line per working session. This is the "where did I stop" record — the phase sections above
describe the *target*, this describes the *position*.

| Date | Phase | Moved | `api.ts` after | Tests | Notes |
|---|---|---|---|---|---|
| 2026-08-03 | 0 | — | 3 331 lines · 179 queries | 23 → **59** | Golden harness + fixture + 36 snapshots. No production code touched. |
| 2026-08-03 | 1 | **50 queries** (28%) | 3 124 lines · **129 queries** | 59 ✅ | `repo/{accounts,categories,transactions,goals,planning,receipts,analytics}.ts`. All of `/analytics` except `patterns`, `category`, `slice`. Four duplicates consolidated; `/analytics/income` bug found and filed, not fixed. |
| 2026-08-04 | 1 | — | unchanged | 59 ✅ | Re-verified the tree against this document. Remaining 129 queries inventoried into batches **A–E** above. |
| 2026-08-04 | 1 | **batch A, 12** | **117** queries | 59 ✅ | `/analytics` tail: `patterns`, `category` (incl. the bucket-13 branch), `slice`, `health`. `/analytics` is now entirely behind the repo layer. |
| 2026-08-04 | 1 | **batch B1, 15** | **102** queries | 59 ✅ | Read-only transactions: detail + tags + receipt, frequent, splits GET, both reimbursement GETs, `/search`. **`STATS_JOINS` / `SPEND_WHERE` / `amountSum` left `api.ts` entirely.** `npm run build` green. |
| 2026-08-04 | 0 + 1 | **batch B2, 32** | **70** queries | 59 → **92** ✅ | Write suite built FIRST (`worker/test/writes.test.ts`, 32 scenarios), then all six write handlers moved. Found and fixed a fixture defect (below). `npm run build` green. |
| 2026-08-05 | 1 | **batch C, 21** | **49** queries | 92 → **108** ✅ | 16 category scenarios recorded first, then create / patch / usage / the 15-query delete cascade moved. `npm run check` + `npm run build` green. |
| 2026-08-05 | 1 | **batch D, 30** | **19** queries | 108 → **141** ✅ | Planning surface: budgets, reports, planned, events. 28 write scenarios + 4 read goldens (`/budgets/auto` ×2, `/planned/detect`, `/reports`) recorded first. New `repo/{budgets,events,reports}.ts`. `npm run check` + `npm run build` green. |
| 2026-08-05 | 1 | **batch E, 19** | **0** queries 🎉 | 141 → **169** ✅ | Accounts CRUD, knowledge corpus, both exports. New `repo/{knowledge,state}.ts`. **`api.ts` line deleted from the budget map — flat ban now.** `catNameSql` fell out of its imports (`tsc` said so unprompted). Second fixture defect found and fixed (below). |
| 2026-08-07 | **3** | **138 routes** | **`api.ts` deleted** 🎉 | 169 ✅ | Split into 16 files under `routes/api/` (largest 769, was 3 331); `index.ts` is a 66-line mount table declaring no route. `services/` created for the three sequence handlers. C1 made recursive + extended to `services/`; **C3 landed** (`check-route-size.mjs`). `npm run check` + `npm run build` green. |

### Phase 0b — the write suite (2026-08-04)

`golden.test.ts` guards what the API *returns*; a write's real output is the state it leaves
behind, and its response is usually `{ok: true}`. So `writes.test.ts` snapshots **both** — the
response and a probe of every table a write may touch (`transactions` projection, `tx_splits`,
`tx_reimbursements`, `transaction_tags`, `merchant_aliases`).

- **The probe is deliberately wider than the row in the URL.** These handlers maintain the
  DENORMALISED columns the canon reads: `recalcStmts` writes `reimbursed` on the expense *and*
  `reimburses_total` on every source it touched. A probe narrowed to the addressed row would go
  green through exactly the §COMPENSATION v2 bug, where money vanished from both spending and
  income.
- **Error paths are scenarios too** (11 of the 32). Most of the code in these handlers *is* the
  validation — the currency guard, the split/compensation exclusion, the ceiling at the expense
  total — and each rule exists because of a specific way real data went wrong.
- **A fresh database per scenario**, unlike the read suite: writes mutate, and a shared fixture
  would make each case depend on the ones before it.
- **Not vacuous** — three deliberate mutations, all caught: `recalcStmts` stops maintaining
  `reimburses_total` → **4 fail**; the §R2-TX4 cleanup stops wiping `real_category_id` → **2**;
  `replaceSplits` stops deleting the old parts → **2**.

**A real defect in the fixture, found by these tests.** The §COMPENSATION rows seeded `reimbursed`
and `reimburses_total` **without inserting the `tx_reimbursements` rows they are derived from** —
a state production cannot reach, since `recalcStmts` is the single writer of both and computes
them from that table. It was not harmless: the endpoint recomputes a source's `available` from
`tx_reimbursements`, so every source looked fully spent, and the scenario aimed at the
"compensation exceeds the expense" ceiling was rejected earlier by the source-exhausted guard —
leaving that ceiling untested. Fixed by seeding the allocations themselves. **The analytics
goldens did not move**, which confirms the canon reads only the denormalised columns and is the
proof the fixture change was safe.

### Phase 0c — the cascade scenarios (2026-08-05)

Batch C needed the write suite to grow three capabilities, each for a reason worth keeping:

- **`GET` and `DELETE` are scenarios now.** `DELETE /categories/:id` is the densest handler in the
  project and had no test of any kind; `/usage` is a read that `golden.test.ts` cannot cover,
  because its whole answer depends on rows that must not exist in the shared fixture.
- **Per-scenario `setup`, not a bigger fixture.** The cascade needs a category carrying
  transactions, tags, aliases, receipt items, a rule, a plan and a budget. Seeding that into
  `fixture.ts` would have moved every analytics golden — and those snapshots are the only evidence
  that the rest of the refactor changed nothing. `seedCategoryCascade` runs on top, per scenario.
- **Opt-in `extraProbes`.** Widening the default probe rewrites all 32 existing write goldens, and
  a churned baseline is one nobody reads. Only the cascade scenarios pay for the six extra tables.

**The harness enforces foreign keys** (`node:sqlite` defaults to it), so the deletion ORDER is
genuinely under test rather than merely documented: a step moved after `DELETE FROM categories`
fails outright. That is why the order is now written at the calls in the handler as well as in
`repo/categories.ts`.

**Not vacuous** — three deliberate mutations, all caught: dropping the tag de-duplicating DELETE
→ **2 fail** (primary-key collision on reassignment); not reassigning `merchant_aliases` → **5**;
not re-parenting sub-categories → **5**. The last two fail as foreign-key violations, which is
exactly the 500 the handler's own comment records from production.

**One rule moved deliberately.** The "a category cannot be its own parent" guard now lives in
`categoriesRepo.update` rather than the handler. It is a property of the row, not of the request,
and a second caller re-deriving it is the first step of the usual divergence. Behaviour for the
existing caller is identical — the golden proves it.

### Phase 0d — batches D and E (2026-08-05)

The suite grew three more capabilities, each earning its keep immediately:

- **`reduceBody`** — `/export/all.json` returns the entire database. Recording that verbatim would
  make the golden a second copy of the fixture, so every unrelated change would rewrite it and
  nobody would read the diff. Only its `meta` block is snapshotted, and that is the part carrying
  the guarantee: the per-table row counts prove the dump enumerates tables from the SCHEMA (so a
  table from a later migration cannot be silently missed) and that `user_secrets` stays out of a
  file that lands on the user's disk.
- **`raw`** — the CSV export is not JSON. Its two dialects are snapshotted as text, which pins the
  `sep=;` line, the decimal comma, and the formula-injection prefix in one readable file.
- **`freezeRandom`** — `POST /knowledge` mints its id from the clock plus a random suffix. The
  clock was already frozen; the suffix was the last non-determinism.

**A second fixture defect, found the same way as the first — by a test going red for a reason
that had nothing to do with the code under test.** `txSeq` was module-level, so a scenario's
transaction ids depended on how many scenarios had run BEFORE it. That quietly undid the write
suite's "a fresh database per scenario" guarantee: adding two knowledge scenarios turned five
unrelated ones red, with diffs that were pure id churn. Left alone it would have trained the next
person to re-record without reading — the exact habit that makes a golden suite worthless. Fixed
by resetting the counter in `seed()`; the write goldens were re-recorded once, and **the analytics
goldens did not move**, which is what confirms the change touched only ids.

**Not vacuous** — eight more deliberate mutations across the two batches, all caught:
`PUT /budgets` skipping its delete-before-insert → **2 fail**; the instalment step ignoring
`period_count` → **2**; deleting an event not unlinking its transactions → **2**; dismissed
merchants not lower-cased → **3**; the manual-account patch dropping its `is_manual` guard →
**4**; account creation not snapshotting the balance → **2**; delete not checking for
transactions → **2**; the export not skipping `user_secrets` → **2**.

### Next session starts here

> **This section is a recommendation, not a mandate.** It records *why* the order was chosen, so a
> later session can disagree on the same evidence rather than re-derive it. If circumstances have
> changed — a bug that needs the type contract first, a deploy that makes the ingest paths urgent —
> switch, and write down what changed. The alternatives are listed at the bottom with their costs.

**Phase 2 — the client↔worker type contract (D2), plus C2 and C4.**

It is the highest-ranked defect still open, and the one argument for deferring it is now spent:
phase 3 was postponing it only because both phases edit the same lines and the split would have
moved the whole diff again. That is done. The lines have stopped moving.

Current state of the target: `shared/types.ts` — **142 lines, 13 types, imported by 0 worker
files**. `src/store/api.ts` — **1 287 lines, 86 hand-written response types**. The client declares
what it believes the server returns; the worker declares its own shapes inline via `.all<{…}>()`;
`tsc` sees two independent truths and cannot reconcile them, so drift surfaces in production.

#### How to do it

1. **One domain per commit** — and the split is what makes that possible: each of the 16 route
   modules is 70–180 lines (bar `analytics.ts`), so "type this domain's responses" is a diff a
   person can read in full. Do the small ones first here, opposite to phase 3: the value is in
   proving the pattern, not in covering volume.
2. **The guarantee comes from the worker annotating its RETURN, not from generation** (decision 5
   at the top of this file). `shared/` holds the type; the handler's return is typed with it; the
   client imports the same one. Then `tsc` catches drift on its own, with no build step and no
   opaque artefact in a public repo.
3. **Start where the shape is already stable and already snapshotted** — `/analytics/*`. The 169
   goldens pin those responses to the kopeck, so a type written against them cannot be wishful.
4. **C2 and C4 land last** (route response types come from `shared/`; the client declares none of
   its own). Same reason C3 landed last in phase 3: a check written while the thing is still
   moving just gets edited every commit.
5. ⚠️ **Do not "fix" a shape while typing it.** A field that is `number | null` in practice gets
   typed that way, even if it looks like an oversight — API shapes are explicitly out of scope
   (§7), and a type change that quietly narrows a response is the same class of silent break the
   goldens exist to catch. File a card instead.

#### If you want something else instead

- **Phase 1 tail (10 queries: `import.ts` 3, `telegram.ts` 3, `setup.ts` 2, `webhook.ts` 2).**
  Empties the budget map so `check-repo-layer.mjs` reports "no inline SQL in worker/routes".
  ⚠️ Deliberately deferred: these are the **least safe queries in the project to move** and deserve
  more care than their count suggests. They sit on the ingest and integration paths — a mono
  webhook, a bot update, the legacy import — with **no characterization coverage of any kind**.
  Unlike batch E, where a mistake showed up as a red snapshot, a mistake here shows up as a
  transaction that silently never arrives. Write a scenario per entry point first (the write suite
  already drives any method and seeds its own rows). A stale allowance of 10 is honest meanwhile,
  and the ratchet still blocks new debt.
- **Phase 4 (D1 own funds, D4 `period_mode`, D5 `RequestContext`).** The only phase that **changes
  behaviour**, so it needs deliberate golden re-recording and an explanation per changed number —
  which is why it is not mixed into a movement phase. Note before starting: verify the register's
  claim about `notify.ts:316` — `credit_limit − balance` there is labelled as computing **debt**,
  which is a different quantity from own funds, not necessarily an inverted copy.
- **Phase 5 (`ai.ts`, 1 335 lines, 6 responsibilities).** Independent of all of the above; the
  provider seam sits between L3 and L4. Note that it is now the largest file in the worker by a
  wide margin, and the only one of this size left outside `routes/`, so it is also the obvious
  next target if the type work stalls.
