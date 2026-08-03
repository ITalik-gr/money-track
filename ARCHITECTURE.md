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
| `worker/routes/api.ts` | **3 331 lines · 179 `.prepare()` · 129 routes · 26 domains** |
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
| C3 | line ceiling per route file | `api.ts` regrowing | phase 3 |
| C4 | client declares no API response types of its own | working around C2 | phase 2 |
| C5 | golden `/analytics` responses match to the kopeck | silent money regressions | ✅ `worker/test/` |

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

### Phase 1 — repository layer + C1 🔄 IN PROGRESS

Moving the 179 queries into `worker/repo/` **without changing the SQL text** (a copy, not a
rewrite — rewriting changes behaviour).

Done so far: `repo/accounts.ts`, `repo/categories.ts`, `repo/transactions.ts`, `repo/goals.ts`,
plus `repo/README.md` documenting the conventions. `api.ts` is at **166 inline queries, down from
179**; golden tests green throughout.

**C1 ships as a ratchet, not a flat ban.** A flat ban would have to land as one enormous commit —
precisely the shape of change that hides a regression. So `scripts/check-repo-layer.mjs` holds a
per-file ceiling that may never rise, and *also* fails when the real count drops below the budget
without the budget being lowered. That keeps a stale allowance from quietly permitting new debt.
Verified to fail in both directions.

### Phase 2 — the type contract + C2/C4
`shared/` becomes the real source; the worker types its returns with it; the client's 86
hand-written types become imports.

### Phase 3 — split `api.ts` + introduce `services/` + C3
129 routes → ~12 domain files. Mechanical once phase 1 is complete.

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
