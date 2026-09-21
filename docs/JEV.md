# JEV.md — every transaction understood by itself

> **Status: phase 1 BUILT and MEASURED (2026-09-21), behind a flag that is off in production.**
> Results in §7.1. Phases 2–4 are still a plan. Written 2026-09-21 on the owner's brief: «щоб jav всі
> транзакції дивився, і автоматично сам розумів що це, скільки, нащо, чи підписка чи ні».
>
> What it replaces is not Haiku. It replaces **asking a text model to do a job that is not text.**
> Read `docs/AI.md` for the current ladder and `docs/CANON.md` before touching any figure here.

---

## 1. What Jev is

TypeSafe's `jev-1.13.0` (`jev-latest`), a "System One" model. It does not write; it **judges**. A
request carries `state` (the facts) and a map of `questions`, and every answer comes back typed,
with a calibrated probability.

| | |
|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer …` |
| Primitives | `choice` (one of a named set) · `noul` (probability a statement is true) · `score` (position on an ordered rubric) |
| Price | **$0.042 per 1M input tokens. Output is free.** Haiku is $1.00 in / $5.00 out |
| Context | 64k per request; 32k for state plus the longest question |
| Limits | 250 000 tokens/sec, 1 200 req/min (their docs say these move with demand) |
| Parallelism | Every question in one request is evaluated **at once** — "adding questions barely changes the response time" |

**The shape of the win is not only price.** One request can carry a dozen independent judgments
about one transaction for roughly the latency of one. That is what makes «розуміти кожну
операцію повністю» affordable at webhook speed, rather than a batch job that runs at night.

---

## 2. The goal, and the one correction inside it

The brief: every transaction, automatically — **what it is, how much, what for, is it a
subscription**.

Three of those four are judgments and belong to Jev. **«Скільки» is not**, and this is the single
most important sentence in this document:

> **The amount never comes from the model. It comes from the bank row.**

That is already the law here (§CANON — money is INTEGER kopecks from the ledger, and
`numbersAreGrounded` exists because a model once invented sums in a notification), and Jev's own
documentation agrees from the other side: it "is not a calculator", cannot count reliably, and
cannot order dates or decide whether one falls in a window.

So the division is clean, and it is the same division this project already keeps:

- **The bank says** how much, when, in what currency, on which account.
- **Jev says** what it was, what for, whether it repeats, whether it was work, how necessary it was.
- **Code says** everything that follows from a number: totals, the reserve, the runway, the limit.

«Скільки» is therefore answered — but by the ledger, which is the only place that can answer it
correctly. What Jev adds is that every figure the ledger holds finally has a **meaning** attached
to it, on every row, without anyone pressing «Розпізнати».

---

## 3. The question set — one transaction, one request

State handed over: the raw bank description, the bank comment, MCC, sign, amount and currency (as
context for plausibility, never for arithmetic), the user's note, the current category, the user
profile, what this merchant was classified as before, and the user's declared subscriptions. The
same payload `enrichTransaction` builds today.

Questions asked **together**, in one call:

| id | type | what it answers | lands in |
|---|---|---|---|
| `root_category` | choice (~24 roots + `none`) | what kind of spending this is | `transactions.category_id` |
| `kind` | choice: expense / income / transfer / withdrawal | is this even spending, or own money moving | `kind`, §F2 |
| `recurring` | noul | is this a charge for a service billed on a schedule | `ai_recurring`, §SUB-DETECT |
| `is_business` | noul | is this work money | `transactions.is_business`, §TAX-BASE |
| `importance` | score: essential → discretionary → optional | how necessary was it | `transactions.importance`, §FLOOR |
| `brand_span` | choice over candidate spans | which part of the raw text is the merchant's name | `clean_name` |
| `known_plan` | choice over the user's declared plans + `none` | which subscription this charge belongs to | §PLAN-LINK |

A **second round** is needed only for the leaf: `leaf_category`, a choice over the children of
whichever root came back. It cannot be asked in the first round because its options do not exist
until the root is known — that is exactly the case their docs name as warranting a second request.

### Two of these are new capability, not a cheaper version of something

- **`importance` per transaction.** Today `t.importance` is an override that is NULL on every row,
  so §FLOOR and §INCOME-SPLIT read importance off the CATEGORY (`EFF_IMPORTANCE`). That means a
  taxi to a hospital and a taxi to a bar are equally «discretionary». A per-row Score fixes a
  weakness in an existing feature rather than adding a screen.
- **`is_business` per transaction.** Today it is inherited from the account and overridden by hand.
  The ФОП module (§BIZ-SPLIT) depends on it entirely, and the owner's own setup step is to go and
  mark things. A proposal per row makes the business page fill itself.

### The confidence rule

Sub-categories roll up into their parent everywhere in this app (§Інваріанти), which means **an
answer one level up is still a correct answer.** So:

- `leaf_category` confidence ≥ threshold → file the leaf.
- below it → **file the root** and stop. Not «unclassified», not a guess.

This is TypeSafe's documented recipe, and on their own benchmark it took useful answers from 65%
to 80%. Here it is better than that, because the root is not a consolation prize — it is what every
total on every screen is computed from anyway.

⚠️ The threshold is a number to be **measured on this ledger** (§7), not copied from their cookbook.

---

## 4. What this changes about §ENRICH-GATE

§ENRICH-GATE exists because asking is expensive: groceries at MCC 5411 are the biggest slice of a
month and asking about them buys nothing the MCC did not already say.

With output free and input at 4.2 cents per million, that argument weakens — but **the gate does
not go away**, for two reasons that have nothing to do with money:

1. **`carry` is still free and still correct.** The second Apple charge does not need asking; the
   first one's verdict is copied. Cheaper questions do not make a redundant question useful.
2. **`skip` protects a column, not a budget.** A skip deliberately leaves `ai_recurring` untouched
   rather than writing 0, because the column distinguishes «asked, and no» from «never asked»
   (migration 0046). Asking about everything would erase that distinction permanently.

What changes is the **size of the skip list**. Several MCCs are on it purely because a model call
was not worth it — those can be asked now, and the eval harness will say whether asking helps.
The rule for staying on the list becomes: *the deterministic answer is complete*, not *it is not
worth the money*.

---

## 5. Where else it fits, in order

1. **§SUB-REVIEW** — the daily «bill or shop» verdict over candidates. A three-option choice today
   carries an invented `unsure` label; in Jev that is confidence, and the third label disappears.
2. **§F2 `transfers-ai`** — «was this really a transfer, and what was the money actually for».
3. **§AI-CATCHUP** — the daily sweep over rows the app failed to file. Same questions as §3.
4. **§CSV-AI `statement-map`** — which column is which field: one choice per column. Interactive,
   so latency is visible to a person here, unlike the rest.
5. **§SEARCH-VEC rerank** — `minScore = 0.45` is a hand-tuned cosine floor, and `NIGHT.md §0.4`
   says the only way to validate it is a live test by hand. A noul per candidate («is this the
   operation the person is looking for») turns a magic number into a judgment. The rule that an
   exact match always wins is untouched.

**Not Jev, and not close:** the adviser, reports, txChat, the budget plan, feed observations — all
generative. Receipt OCR needs vision; Jev is text only.

---

## 6. Where it lands in the code

- **`worker/lib/ai/judge.ts` — the ONLY file that POSTs to TypeSafe.** Sibling of `ai.ts`, not a
  layer beneath it. ⚠️ It does **not** go behind the `json.ts` provider seam: that seam is for
  providers that complete JSON, and Jev's API is a different shape. The ROADMAP card about
  multi-provider AI is about swapping Anthropic and is unrelated to this.
- **`worker/lib/ai/judge-tx.ts`** — the question set of §3 and the confidence rule. Its own file
  because `enrich.ts` is at 393 of 400 lines (C3) and cannot take it.
- **`cost.ts`** — a second price basis. `AnthropicUsage` does not describe input-only, output-free
  billing, and a Jev call logged through the Anthropic table would report a made-up cost.
- **`demo.ts`** — `demoClamp` knows Anthropic models only. A demo either gets its own Jev ceiling
  or does not reach Jev at all.
- **`env.ts` / `user_secrets`** — the key, stored the same encrypted way as the others.
- **`docs/PERIMETER.md`** — one factual line recording that operation text now also reaches
  TypeSafe. Not a question to re-open; that file is the map of where data goes, and a map missing a
  destination is the failure it exists to prevent.

---

## 7. How this gets decided — measurement, not opinion

**`npm run eval` already exists and already reports exactly the right numbers** (§AI-EVAL): root
accuracy, exact accuracy, recurring accuracy, gate accuracy, ask rate and cost — the last two
together, so a change cannot look cheaper while quietly going blind. 132 cases on a real schema.

The procedure is therefore fixed:

1. `npm run eval --record` on the current Haiku ladder — that is the baseline, and it already is.
2. Build the Jev path behind a flag.
3. `npm run eval` on each, compare the same six numbers.
4. Ship the branch that wins **root accuracy**; use the cost column to decide how far the gate's
   skip list can shrink.

⚠️ The harness runs the PRODUCTION ladder end to end, not a copy of it. A Jev path that the eval
cannot reach has not been measured, whatever it does in a screenshot.

### 7.1 Phase 1 result (2026-09-21)

Same 132 cases, same gate (99 asked, 5 carried, 28 skipped on both), run three times for Jev — the
numbers did not move between runs.

| | Haiku ladder (+ Sonnet on a note) | Jev, 3 questions |
|---|---|---|
| root accuracy | 97.8% (91/93) | **98.9% (92/93)** |
| recurring accuracy | 97.2% (35/36) | 97.2% (35/36) |
| gate accuracy | 100% | 100% (same code) |
| cost of the run | $0.258 (89 Haiku + 10 Sonnet calls) | **$0.0064** (99 calls) |
| per 1 000 ingested rows | ~$1.96 | **~$0.05** |
| wall time, concurrency 4 | 42 s | 8–10 s |
| exact (leaf) accuracy | not declared by the dataset | — (phase 1 files roots only) |

Misses: Haiku — `app-store-oneoff` (recurring), `csv-kasta`, `csv-optika`. Jev —
`app-store-oneoff` (recurring, noul 0.53), `csv-kasta` (Jev does not know the brand; the Haiku
guide does not name it either, so neither was told).

**What it took, because the first run was 93.5% / 83.3%:**
1. **Brand examples in the root criteria.** Jev did not know Allo, Intertop or MEGOGO; with the
   SAME brands the Haiku guide (`CACHE_GUIDE`) already names, it does. A brand that appears only in
   an eval case was tried and taken back out (Kasta) — that is fitting the test, not the ledger.
2. **The recurring question named its borderline classes** (mobile top-up, ОСББ, yearly insurance,
   domain renewal). Before, every utility bill sat at noul 0.44–0.47 — just under the line — so the
   0.5 threshold was never the problem; the question was.
3. **`user_note` first in the state.** SILPO + «розваги» was a 0.47/0.45 split with the note last.
4. **Reconciliation by confidence, not «kind wins».** The two questions cannot see each other; a
   ~0.5 «transfer» was overriding Transport at 0.99 and made UKLON flip between runs.

⚠️ **Read the table with its caveat.** The criteria were tuned while looking at this same dataset,
so 98.9% is an in-sample number. The Haiku prompt has had months of the same treatment, so the
comparison is fair in kind — but the next honest step is new cases that neither branch was tuned on.

**Where it lives:** `worker/lib/ai/judge.ts` (transport, owner-only gate), `judge-tx.ts` (the
questions and reconciliation), `ENRICH_JUDGE=jev` + `JEV_API_KEY` on the env,
`npm run eval -- --judge jev` (writes `baseline.jev.json` / `last-run.jev.json`, never the Haiku
files). Pinned without network by `worker/test/judge-tx.test.ts`.

---

## 8. Known jaggedness, and what each one costs here

Their published limitations for 1.13, mapped onto this ledger:

| Their limitation | What it would break here | Handling |
|---|---|---|
| Not a calculator; cannot count | Any sum | Already impossible: figures come from the ledger (§2) |
| Cannot compare or order dates | «is this within the quarter», §TAX-DUE, §PLAN-LATE | Already code, all of it |
| Literal reading — answers the question as written | A sloppy `instructions` string silently answers something adjacent | Criteria describe concrete situations; every question is pinned by an eval case |
| Irrelevant context degrades answers | Our payload carries profile, history and declared plans | Measure with and without each field; a field that does not move accuracy comes out |
| No structural invariants between questions | `kind: transfer` alongside a confident grocery category | Code reconciles; `kind` wins, as it does today |
| Adversarial content is not treated as hostile | A merchant name is partly attacker-controlled text | **Lower risk than today**: the output is a typed choice from OUR list, so an injected instruction cannot become free text on a screen |
| Text generation is unreliable and slow | `clean_name`, `note` | `clean_name` is span selection, not generation. `note` stays on Haiku or goes — it is the only field nothing computes from |

---

## 9. Phases

**Phase 1 — measure.** `judge.ts` + `judge-tx.ts` with `root_category`, `kind`, `recurring` only,
behind a flag. Run the eval both ways. Nothing user-visible. *This is the whole decision.*

**Phase 2 — the full row.** Add `leaf_category` (second round, confidence rule), `brand_span`,
`known_plan`. Re-measure. Shrink the gate's skip list by what the numbers allow.

**Phase 3 — the new columns.** `importance` and `is_business` per transaction, both written as
PROPOSALS the user can overturn — the same way §A1 facts and advice suggestions already work.
Never silently authoritative: `is_business` moves a tax figure.

**Phase 4 — the other call sites.** §SUB-REVIEW, §F2, §AI-CATCHUP, §CSV-AI, then the search rerank.

---

## 10. Open, and the owner's call

- **Whose key.** Deployment-wide (the owner's, like `ANTHROPIC_API_KEY`) or per user? Enrich runs
  from a webhook for everybody, so this decides who pays for a stranger's ledger.
- **Availability.** TypeSafe's own docs say rate limits «are adjusting dynamically» under demand.
  The webhook path must degrade to the Haiku ladder rather than lose the verdict — which argues
  for keeping the Haiku path alive behind the flag rather than deleting it after phase 2.
- **The confidence threshold**, which is a measurement, not a preference — but where it sits is a
  trade the owner makes: a leaf more often, or a root more reliably.
