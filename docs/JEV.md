# JEV.md — every transaction understood by itself

> **Status: phases 1–4 BUILT and MEASURED (2026-09-21).** `AI_JUDGE = "jev"` in `wrangler.jsonc`
> turns it on; it reaches the OWNER only (the key is the owner's, §10). Results in §7.1–7.4; the
> search rerank was measured and deliberately NOT wired (§7.4). Written 2026-09-21 on the owner's brief: «щоб jav всі
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
- **`judge-guide.ts`** — the category guide, PARSED out of Haiku's `CACHE_GUIDE`, so both judges
  read one definition of every category (§7.2).
- **Phase 4, one file per site:** `judge-subs.ts` (§SUB-REVIEW) · `judge-spend.ts` (§F2 real
  category + §AI-CATCHUP) · `judge-columns.ts` (§CSV-AI) · `judge-search.ts` (measured, NOT wired).
  Each returns null when Jev is off, down or unsure, and its caller then runs the Claude path
  exactly as before — no call site lost its fallback.
- **The switch:** `judgeOn(env)` in `judge.ts` = `AI_JUDGE === "jev"` AND `judgeAvailable` (key +
  owner + not a demo). Every site asks that one function.
- **`cost.ts`** — a second price basis. `AnthropicUsage` does not describe input-only, output-free
  billing, and a Jev call logged through the Anthropic table would report a made-up cost.
- **`demo.ts`** — `demoClamp` knows Anthropic models only. A demo either gets its own Jev ceiling
  or does not reach Jev at all.
- **`env.ts` / `user_secrets`** — the key, stored the same encrypted way as the others.
- **`docs/PERIMETER.md`** — one factual line recording that operation text now also reaches
  TypeSafe. Not a question to re-open; that file is the map of where data goes, and a map missing a
  destination is the failure it exists to prevent.

---

## 7. How this gets decided — measurement, not opinion (§JEV-EVAL)

> **§JEV-EVAL.** A Jev judgment is wired into a call site only after it is measured on cases written
> BEFORE the code, against the Claude path it replaces — `npm run eval -- --judge jev` for enrich,
> `node scripts/eval-sites.mjs` for the rest. Both run without spending on Claude unless `--claude`
> is passed. A line (cascade, leaf, subscription, business) is set from a measured gap, never guessed,
> and a site where no line separates the two sides is NOT wired (the search rerank, §7.4).

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
questions and reconciliation), `AI_JUDGE=jev` + `JEV_API_KEY` on the env,
`npm run eval -- --judge jev` (writes `baseline.jev.json` / `last-run.jev.json`, never the Haiku
files). Pinned without network by `worker/test/judge-tx.test.ts`.

### 7.2 Phase 2 result — held out, a cascade, the leaf and the name (2026-09-21)

**The phase-1 number did not survive new data.** 36 cases were written BEFORE any phase-2 work
(`group: "holdout"` in `cases.json`) and never used to tune anything. On them, phase-1 Jev scored
**72.2% root**; Haiku scored 97.2% root and 100% leaf. Jev filed shops it had never heard of
(Nova Liniya, Citrus, Prostor, Antoshka) under «Other». The cause was ours, not the model's: the
phase-1 criteria were a hand-condensed copy of `CACHE_GUIDE` that had dropped its brand lists —
a second definition of the categories, which is exactly the failure this project keeps a rule
against. Now `judge-guide.ts` parses the SAME guide Haiku reads, and a test pins that every seed
category comes out of it with a text. (Several holdout brands are in that shared guide — that is
knowledge both judges get, not tuning; none of the 36 was added to it.)

What phase 2 built:
- **The cascade.** Jev files a row only when its root probability is ≥ `ROOT_CASCADE_AT` = 0.8;
  below, it returns null and the Haiku ladder answers. Measured on a sequential run with no
  cascade (135 asked rows): every root at ≥ 0.8 was right (99/99 scored); all 6 misses sat
  between 0.41 and 0.74. At 0.7 one miss slips through (MEGOGO → Utilities at 0.74). Own money
  moving is exempt — the transfer bucket asks its real question in §F2 step 2 anyway.
- **The leaf** — a second request over the chosen root's children plus «none of the specific
  ones», filed at ≥ `LEAF_AT` = 0.6, else the root. Only roots WITH children pay for it.
- **The name** — Jev SELECTS a span of the raw description that code cut out (numbers never
  stand alone, code-like tokens are dropped, «CITRUS.UA» also offers «CITRUS»). It cannot invent
  a spelling; «none of these» keeps the ladder's name.
- **`known_plan` was not built:** `applyEnrichment` already links a charge to a declared plan
  deterministically (`matchActiveSubscription`), and it is now handed a clean name to do it with.
  A judgment would be a second answer to a question code already answers.

All 168 cases, `npm run eval -- --judge jev` (no Claude key — deferred rows are reported, not scored):

| | Haiku ladder | Jev alone (answered rows) | Jev → Haiku cascade |
|---|---|---|---|
| rows Jev answers | — | 115 of 135 asked (85%) | same |
| root | 97.7% (126/129) | **100% (119/119)** | 98.4% (127/129)¹ |
| leaf (exact) | 100% (13/13) | 92.3% (12/13) | — |
| recurring | 95.5% (42/44) | 95.0% (38/40) | — |
| name (holdout) | 81.3% (26/32) | 85.2% (23/27) | — |
| per 1 000 ingested rows | ~$1.96 | ~$0.10 (incl. leaf rounds) | **~$0.40**² |

¹ Derived, not paid for: the cascade's root misses are exactly Haiku's own misses among the
deferred rows (`csv-kasta`, `ho-wise`); both were already recorded in Haiku runs.
² Jev on every asked row + Haiku (~$0.0026 per ask, from its own run) on the ~15% it hands on.

Honest reading: the cascade does not beat Haiku by much on accuracy — it matches it, and costs
about a fifth. The rows Jev keeps it gets right; the rows it gives away are the ones Haiku was
going to be needed for. The deferred count moves by ±1 between runs (19–20): Jev is not perfectly
deterministic at the line.

Remaining misses on Jev-answered rows: `app-store-oneoff` (recurring — Haiku misses it too),
`ho-lanet` (recurring 0 — an internet provider it does not recognise), `ho-ekomarket` (Groceries
instead of Supermarket — leaf below the line, the root was filed as designed), and four names that
are defensible («Multiplex Lavina», «Justin Poshta»).

### 7.3 Phase 3 result — the skip list, and the two new columns (2026-09-21)

No Claude was spent on any of this: `--judge jev` withholds the Anthropic key by default.

**The skip list stays as it is — measured, not assumed.** `--force-ask` runs Jev over the 28 rows
§ENRICH-GATE skips. On every obvious MCC (5411, 5499, 5462, 5812/5814, 4121, 5541/5542, 4111,
5912) its root agreed with the MCC 100% and `recurring` came back 0 — asking buys nothing the code
did not already know. On own money moving it was WORSE than skipping: the round-up went from the
transfer bucket to «Other». Both of §4's reasons for the gate held; the list is complete as it is.

**Two new PROPOSALS per row** (migration 0054, never the columns the canon or the tax reads):

| | Jev, first run, criteria written before it | What the app does with it |
|---|---|---|
| `ai_importance` (Score, 3 levels of §6) | 86.1% (31/36) | stored only — every 7th proposal would be wrong |
| `ai_business` (Noul) at 0.5 | 89.5% (17/19) | offered on the operation page (thresholds below) |

The expectations were written into `cases.json` BEFORE the first run, and nothing was tuned after
it. The one criterion edit — «a salary from an employer is employment, not the holder's business» —
went in before the run too: it is §TAX-BASE's definition, not a fix for a miss.

**Business is well separated, so the thresholds are measured:** every work row came back
≥ 0.88, every personal one ≤ 0.56 (the two misses at 0.5 were Netflix and a children's shop, both
read by a sole-trader profile). The page offers «Схоже на робочу» at ≥ 0.8 on a personal account
and «Схоже на особисту» at ≤ 0.3 on a business one — zero wrong offers on this set, and only
where accepting would change what the account already says.

**Importance misses** are groceries (Novus, Fora) and connectivity (Vodafone, Lanet) read as
«discretionary». Not tuned: they are the first honest number. The structural next step is to ask
importance in the second round, where the ROOT is known — a question that knows «this is
Groceries» is a different question, not a reworded one.

### 7.4 Phase 4 result — the other call sites (2026-09-21)

A separate harness, `scripts/eval-sites.mjs`, over `worker/test/__eval__/sites.json` — 20
merchants, 12 transfers, 20 search pairs, 7 statement files, **written before any phase-4 code**.
Jev alone costs ≈ $0.003 a run; Claude was run ONCE for comparison (`--claude`).

| Site | Jev | Claude (same cases) | Decision |
|---|---|---|---|
| §SUB-REVIEW «bill or shop» | 19–20/20 right, **0 wrong**, 0–1 unsure | 19/20, 0 wrong, 1 unsure | wired |
| §F2 real category of a transfer | answers 11/12 (≥ 0.8), **11/11 right** | 10/12 | wired, Claude below the line |
| §CSV-AI column mapping | 6–7/7 files fully right | 6/7 (took a split debit column as «amount») | wired, same proof as Claude |
| §AI-CATCHUP | the enrich + §F2 judgments above, per row | — | wired, «unsure» stays a gap |
| §SEARCH-VEC rerank | 16–17/20, and **no line separates** | — (baseline is the cosine floor) | **NOT wired** |

What moved while measuring, said plainly:
- **Subscription lines.** The pre-set 0.7 / 0.3 called five real bills «unsure». Every real bill
  came back ≥ 0.52 and every shop ≤ 0.43 over two runs, so the lines are 0.5 / 0.4. That makes the
  subscription half of `sites.json` in-sample for the THRESHOLD, and the gap is thin — new
  merchants go into the set before the lines move again.
- **A leak, caught and removed.** The `utility` rubric named «EasyPay», which is also a case. With
  it removed EasyPay still comes back a bill (0.66), now typed «unclear».
- **The reason a person reads is ours.** Claude wrote a sentence; Jev picks a merchant TYPE and the
  screen shows that type's translated label (`i18n-judge.ts`). Nothing a merchant name smuggles in
  can reach the screen.
- **Search.** «Фора» came back 0.59 for «коли я купував запчастину до велосипеда» and the bicycle
  workshop 0.46: that is not a threshold problem, it is the judgment being unreliable here. The
  cosine floor stays; `judge-search.ts` stays only so a newer Jev is re-measured with one command.

**And importance, restructured (phase-3 follow-up).** Asking importance in ROUND 2, where the root
is known («this is Groceries»), moved it from 86% to **97%** (35–36/36–37) for ~5% more requests.
At 97% it is now offered on the operation page too, beside the importance picker, only where it
differs from what the category says, and only INTO the form — saving is still the person's click.

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

**Phase 2 — the full row.** ✅ Done (§7.2): leaf round, span-selected name, the cascade.
`known_plan` deliberately not built (§7.2). The gate's skip list was NOT shrunk yet — that is
phase 3's first measurement.

**Phase 3 — the new columns.** ✅ Done (§7.3): `ai_importance` + `ai_business` as proposals; the
business one is offered on the operation page; the skip list measured and kept.

**Phase 4 — the other call sites.** ✅ Done (§7.4): §SUB-REVIEW, §F2, §AI-CATCHUP and §CSV-AI
wired with Claude as the fallback; the search rerank measured and NOT wired.

---

## 10. The owner's calls

- **Whose key — DECIDED 2026-09-21: the owner's, for now.** `JEV_API_KEY` is a Worker secret and
  `judgeAvailable` admits the owner only. Opening it to other users is a per-user key (the
  `user_secrets` path Anthropic keys already take) — a change of code, not of a flag.
- **Availability.** TypeSafe's own docs say rate limits «are adjusting dynamically» under demand.
  The webhook path must degrade to the Haiku ladder rather than lose the verdict — which argues
  for keeping the Haiku path alive behind the flag rather than deleting it after phase 2.
- **The confidence threshold**, which is a measurement, not a preference — but where it sits is a
  trade the owner makes: a leaf more often, or a root more reliably.
