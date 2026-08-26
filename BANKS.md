# BANKS.md — the second bank, and every bank after it

> **Read this before writing any bank integration.** It records what PrivatBank actually offers
> (measured 2026-08-13, not remembered), what its data shape breaks in this project's canon, and
> which parts of our own provider abstraction are still declarations rather than working code.
> How money is *counted* is `CLAUDE.md`; layers and lints are `ARCHITECTURE.md`; the queue is
> `ROADMAP.md`. This file is the "why it is like this" for the bank edge.

---

## 1. The finding that changes the plan

The ROADMAP card for PrivatBank said step 1 was "check the CURRENT personal API". Done, and the
answer removes the card as it was written:

**PrivatBank has no API for a private person's cards.** `api.privatbank.ua/p24api` (the merchant-id
+ password `rest_fiz` endpoint every old blog post describes) was **closed on 18 July 2023**. There
is no replacement for individuals. What exists:

| Route | Who it is for | Gives us | Verdict |
|---|---|---|---|
| **AutoClient** `acp.privatbank.ua/api/statements/*` | Приват24 для бізнесу — ФОП on any tariff, legal entities on Business Comfort/PRO | The ФОП settlement account: balances + transactions | **This is the integration.** Feasible today. |
| **Open banking** (NBU Resolution No. 80, in force 2025-08-01) | NBU-authorised TPPs only | Personal accounts, balances, 31 days of transactions | **Out of reach** — see §2.3. |
| CSV / XLS export from Privat24 | Anyone | Everything, by hand | **Already supported** (`providers/csv.ts`), and stays the answer for personal cards. |

So the honest scope of "PrivatBank support" is: **the owner's ФОП account, over AutoClient, by
polling.** Personal Privat cards stay on the CSV path, and the product should say so plainly rather
than let a user link a bank and find their card missing.

---

## 2. What each route actually is

### 2.1 AutoClient v3 — the one we can use

- **Base:** `https://acp.privatbank.ua`. TLS 1.0/1.1 refused; 1.3 recommended.
- **Auth:** headers `token` (from Приват24 для бізнесу → Автоклієнт → API application) and
  `User-Agent`. There is also an `id`; in group mode it rides as a query parameter `ID=<client_id>`.
- **Endpoints:**
  - `GET /api/statements/settings` — server phase. **If `phase !== "WRK"` requests may fail**: this
    is a real state to handle, not a health-check nicety.
  - `GET /api/statements/balance?acc&startDate&endDate&limit&followId`
  - `GET /api/statements/transactions?acc&startDate&endDate&limit&followId`
- **Dates:** `DD-MM-YYYY` in the request. **No time component**, so the smallest window we can ask
  for is a day — the poll cursor is a DAY, not a timestamp, and overlap is unavoidable (which is
  fine, because dedup is by id, not by window).
- **Pagination:** `exist_next_page` + `next_page_id` → pass back as `followId`. `limit` default 20,
  max 500, documentation recommends ≤100. Interim (non-final) data caps at 100 per request.
- **Rate limits:** **not documented.** That is not the same as "none" — treat it as unknown and pace
  conservatively (§4, step 3), because an undocumented limit is discovered in production.
- **No push of any kind.** Mode is `poll`, exactly as `ProviderMode` already anticipated.

**One transaction, and what each field costs us:**

| Field | Meaning | What it means for us |
|---|---|---|
| `ID`, `REF` + `REFN` | transaction id; docs say uniqueness is `REF`+`REFN` | our `transactions.id` is a global TEXT key, so it must be namespaced (`pb_…`) — an unprefixed bank id can collide with a mono one |
| `TRANTYPE` | `D` debit / `C` credit | **the sign is not in `SUM`** — direction is a separate field, and getting it wrong inverts a statement silently |
| `SUM` | amount, decimal string | one conversion to integer kopecks, in the provider, once |
| `SUM_E` | same amount in UAH | do NOT use it as the amount: our invariant is "amount in the ACCOUNT's currency", and `SUM_E` is a second opinion about money |
| `CCY` | `"UAH"` — **letters** | we store ISO-4217 **numeric** (980) everywhere. No letters→numeric map exists in the worker today (§3.1) |
| `DATE_TIME_DAT_OD_TIM_P` | `DD.MM.YYYY HH:MM:SS` | **Kyiv local time.** Parsing it as UTC shifts every evening operation into the next day (§3.2) |
| `DAT_OD` / `DAT_KL` | value date / client date | two dates that disagree; pick one and write down which |
| `PR_PR` | `p` processing · `r` executed · `t` reversed · `n` rejected | mono has only hold/settled. `t`/`n` are a state this app has never had (§3.3) |
| `FL_REAL` | `r` real / `i` interim | interim rows are the ones capped at 100/request |
| `OSND` | payment purpose | the ONLY description we get |
| `AUT_CNTR_NAM`, `AUT_CNTR_ACC`, `AUT_CNTR_CRF` | counterparty name / account / tax id | the merchant substitute — and a stable key better than any name |
| — | | **there is no MCC and no cashback** (§3.4) |

Balance endpoint returns `balanceIn/balanceOut(+Eq)`, `turnoverDebt/Cred(+Eq)`, `dpd` (last
movement), `nameACC`, `state`, `is_final_bal`, keyed by `acc` (IBAN) and `currency` (letters).
`balanceOut` is the account balance we sync; `is_final_bal` says whether the day is closed.

### 2.2 Why the ФОП account is a different animal from a card

The settlement account is not a card feed. Its rows are bank transfers with a purpose line — no
merchant, no MCC, no cashback, and every incoming payment is business revenue rather than a
purchase. Two consequences worth deciding BEFORE writing the provider:

1. **Categorisation loses its strongest step.** `categorize()` runs alias → subscription → merchant
   consensus → **mcc/text rules** → AI. With no MCC, 188 seeded rules never fire, and the whole
   weight falls on text rules over `OSND` + `AUT_CNTR_NAM` and on AI enrich. §RULES-UI exists now,
   so this is a matter of seeding a few rules rather than new machinery — but it must be a
   deliberate step, not a surprise on first sync.
2. **A ФОП account is not a spending account**, and mixing it into the personal picture would
   quietly change every number this app is about. `accounts.role` already carries
   `liquid | investment` (§R3) and this is a third meaning: money that is turnover, not yours.
   **Decide before syncing**, or the first sync moves the cushion, the runway and the burn rate.

### 2.3 Open banking — the correct route, and why not yet

PrivatBank publishes an open-banking API and a sandbox with depersonalised ФОП/individual test
accounts (UAH/USD/EUR). Production access requires **a valid QWAC certificate from an NBU-qualified
CA and TPP authorisation from the NBU**. A personal finance app used by its author and friends is
not going to be an authorised AISP.

Worth recording anyway, because the constraints shape any future design: **one account per
consent**, consent lifetime **≤90 days**, **max 4 requests per day without the user present**,
transaction history **limited to 31 days**, decoupled SCA via push. Note what that implies —
open banking is a **fourth mode**, not a variant of `poll`: it has a consent object with an expiry,
a re-authorisation flow, and a request budget. Our model has nowhere to put any of that today.

The regulation took force 2025-08-01 and banks had until January 2026 to expose the APIs; the market
is expected to be real by late 2026. The sandbox is the only part usable now, and only as a study.

---

## 3. What Privat's shape breaks in our canon

Each of these is a place where a wrong decision does not throw — it produces plausible wrong money.

### 3.1 Currency arrives as letters, and we store numbers
`transactions.currency_code` / `accounts.currency_code` are ISO-4217 **numeric** everywhere
(`980`), and the only letter map in the repo is `CURRENCY` in `src/lib/format.ts` — client-side and
numeric→letters. Privat gives `"UAH"`. A letters→numeric map is **shared infrastructure, not Privat
code**: every future bank and every CSV with a currency column needs the same one, and two copies of
it will disagree on the day someone adds `GBP` to one of them.

### 3.2 Timestamps are Kyiv local — and the CSV parser already gets this wrong
`parseDateUnix` (`providers/csv.ts`) builds `dd.mm.yyyy hh:mm` with `Date.UTC(...)`. Ukrainian bank
exports write **local** time, so an evening purchase is stored ~3 hours late and renders on the next
day — the §APP_TZ bug again, on the import path this time. **Found by reading, not by a failing
test.** It is a latent bug today (CSV imports) and a certain one the moment Privat's
`DATE_TIME_DAT_OD_TIM_P` goes through the same door. Fix it where the app already knows how: the
`localParts`/`APP_TZ` helpers in `stats.ts` resolve the offset per moment, so DST handles itself.

### 3.3 `PR_PR` has states mono never had
mono has one volatile state (`hold`) and one settlement rule: same id, overwritten. Privat has
**four** — and `t` (reversed) and `n` (rejected) describe money that did **not** move. Writing them
as transactions creates spending that never happened; ignoring them silently is also wrong, because
a row can go `p → t` after we have already stored it as real. So the upsert must be able to
**retract**, which is a verb this codebase does not have. Cheapest honest option: store the state,
and let the canon exclude non-executed rows the way §REFUND excludes what is not spending — one
place, not five.

### 3.4 No MCC, no cashback, no per-row balance
`balance_after` is absent (balances are a separate endpoint), so the field stays `NULL` — already
allowed, and net-worth reconstruction reads `accounts.balance`, so nothing downstream breaks. MCC
absence is the categorisation problem in §2.2.

---

## 4. What our abstraction cannot do yet (measured, not assumed)

`BankProvider` (`worker/lib/bank/providers/provider.ts`) has the right shape: `webhook | poll |
manual`, canonical account and transaction types, normalisation stated as the provider's one job.
The registry, the `accounts.provider` column and `bank_connections` (migration 0032) all exist. What
is missing is that **half of it has never been executed**:

1. **`poll()` has zero callers.** It is a declaration. Nothing in `UserDO.armAlarm` knows about a
   poll deadline; the alarm has three claimants (demo expiry, backfill pacing, AI jobs) and would
   need a fourth, with its **own timestamp** — the lesson §A6 already paid for: pacing that lives in
   the alarm's time gets consumed by whichever other job fires first.
2. **`bank_connections` is completely unused** — no read, no write, anywhere. Multi-bank has no
   other place to record which credential feeds which accounts, when it last synced and why it
   failed. `accounts.connection_id` is likewise never set.
3. **The backfill is mono, not a backfill.** `lib/bank/backfill.ts` calls `getStatement(env.MONO_TOKEN, …)`
   directly, hardcodes mono's 31-day window and its 60 s pacing, and catches `MonoRateLimit`.
   Privat's shape is different in every one of those (day-granular windows, `followId` pages,
   unknown limit), so the pacing and window constants belong **to the provider**, and the cursor
   belongs to a **connection**, not to `app_state.backfill_cursor` singular.
4. **There are already TWO writers of `transactions`, and Privat would be the third.**
   `repo.upsertMonoTx` (mono-shaped, `source='mono'`, handles hold/original-currency/unpairing) and
   `csv.importTransactions` (`source='import'`, `INSERT OR IGNORE`, no hold, no original currency).
   This is exactly the shape §CUR-PLAN and §A1-WRITE were written about: one concept, two
   implementations, drifting where nobody looks. **A canonical writer is the single highest-value
   thing to do before any new bank** — and it is a refactor with tests, not a feature.
5. **Credentials are a closed two-name union.** `SecretName = "mono_token" | "anthropic_api_key"`
   (`lib/platform/secrets.ts`); `credentials.ts` verifies mono specifically. Privat needs **two**
   values (`id` + `token`) under one connection.
6. **`env.MONO_TOKEN` is read directly** in `routes/setup.ts` (×3) and `backfill.ts`, and
   `UserDO.userCredentials` types credentials as a fixed pair. A provider-agnostic "the credential
   for this connection" resolver has to exist before a second one appears.
   ⚠️ **And it must carry the security invariant with it:** a deployment-wide secret is the
   OWNER'S ONLY (§Безпека — this exact bug shipped twice). A global `PRIVAT_TOKEN` fallback would
   recreate it on day one; Privat should have **no deployment-wide fallback at all**, owner
   included, since there is nothing to be backward-compatible with.
7. **The client knows the name but not the flow.** `BANK_LABEL` in `Accounts.tsx` already maps
   `privat: "PrivatBank"`, but there is no "add a connection" UI, no per-provider credential form,
   and Settings holds a mono-token card. `listProviders()` exists and nothing calls it.

---

## 5. The preparation, in the order that pays off

Every step below is worth doing on its own merits and leaves the app better even if PrivatBank never
happens. That is the test each step had to pass to be on this list.

| # | Step | Why it is first |
|---|---|---|
| ~~1~~ | ✅ **DONE 2026-08-13 — `repo/ingest.ts` `upsertCanonicalTx` is the only writer.** `upsertMonoTx` kept its signature and its normalisation and lost its SQL; `importTransactions` is now a loop around the same call. The two real differences became arguments (`onConflict`, whether an account may be minted) — see §INGEST-WRITE in `CLAUDE.md`. **The mono goldens did not move at all**, which is the proof the refactor asked for. | Three writers is how money starts disagreeing with itself. |
| ~~2~~ | ✅ **DONE 2026-08-13 — `lib/bank/normalize.ts`.** `parseAmountMinor` moved out of `csv.ts`, `parseStatementDate` fixed to read a zone-less wall clock as Kyiv (§3.2 — imported rows moved back 3 h, the only golden change), `currencyNumeric` added with a real consumer: the import preview now warns when the FILE names a currency the ACCOUNT does not hold. `localMidnight` generalised into `localWallTime`. 15 assertions in `normalize.test.ts`. | Fixes a live bug and stops each provider from inventing its own money parsing. |
| ~~3~~ | ✅ **DONE 2026-08-13 — `BankProvider.statement` owns window, gap and rate-limit recognition.** The cursor carries the provider per job; both pacers (DO alarm, client interval) read `nextStepGapMs`; mono's normalisation moved to `monoToCanonical` in `lib/bank/mono.ts`, shared by the webhook and the fetch. 8 scenarios against a FAKE bank in `backfill.test.ts` — the path had NO tests before. See §BANK-FETCH in `CLAUDE.md`. | Turns `backfill.ts` from "mono's backfill" into the thing its name claims. |
| ~~4~~ | ✅ **DONE 2026-08-13 — `repo/connections.ts`**, written on every sync attempt (account sync, backfill step, poll pass), `connection_id` set on success, `BankConnectionsCard` in Settings. §BANK-CONN in `CLAUDE.md`. | Without it there is no answer to "which token feeds this account" and no place to show a failing bank. |
| ~~5~~ | ✅ **DONE 2026-08-13 (partly) — `bankCredential(env, id)` is the one answer**, fed by `env.BANK_CREDENTIALS` built in `UserDO.appEnv`, where the owner gate already lives. §BANK-CRED in `CLAUDE.md`. ⚠️ **What is deliberately NOT done:** the multi-VALUE shape (Privat needs id + token) and the `SecretName` whitelist entry. Both are one line each and neither can be designed honestly without the provider that uses them — a credential form for a bank nobody has linked would be a guess. They land with step 7. | See §4.6. Security invariant, not ergonomics. |
| ~~6~~ | ✅ **DONE 2026-08-13 — `lib/bank/poll.ts`**, the fourth claimant on the object's single alarm. One account per pass, an overlapping window, its own request timestamp. 7 scenarios. §BANK-POLL in `CLAUDE.md`. | §A6's rule, applied to the fourth claimant. |
| ~~7~~ | ✅ **DONE 2026-08-13 — `lib/bank/privat.ts` + `providers/privat.ts`**, ~250 lines including comments, which is the evidence that 1–6 were the actual work. Credential is JSON (`{id, token}`) in `privat_credentials`, verified against `/api/statements/settings` before it is stored; 17 mapping scenarios. ⚠️ **Never run against the live service** — see §7. | Small, once 1–6 exist. If it is big, one of 1–6 was skipped. |

**Done when** (for the integration itself): a ФОП account syncs its balance and 90 days of history,
a rejected/reversed row never counts as spending, the numbers agree with a statement exported by
hand, and the UI says truthfully which banks give what — including that Privat personal cards are
CSV-only.

---

## 5.1 What "done" means for PrivatBank, precisely (2026-08-13)

**Written and green: 400 tests, all lints, build.** What that does and does not buy:

- ✅ A ФОП credential can be stored (verified against the live `settings` endpoint before saving),
  accounts pulled from `/balance`, 90 days backfilled through the shared paced loop, and new
  operations polled every 30 minutes. Rows land through the ONE writer, so they are categorised,
  rolled up and counted by the same canon as monobank's.
- ⚠️ **It has never spoken to the real API.** There is no ФОП account to link and no public
  sandbox, so what is proven is the MAPPING (the sign is in `TRANTYPE`, `PR_PR` `t`/`n` is not
  money, the wall clock is Kyiv, ids are namespaced) — not the wire. Expect the first live run to
  need one round of fixes; the likely candidates are the `ID` group-mode parameter (sent only when
  the user supplies an id) and the exact spelling of the balance fields.
- ⚠️ **Known gap, left on purpose:** a row stored while `p` (processing) that later becomes
  reversed stays stored. Retracting a transaction is a verb this codebase does not have — the canon
  has no "voided" state — and inventing one blind, for a bank nobody has linked, would bake a guess
  into the money rules. It belongs with the first real account.
- ⚠️ **Not done:** the ФОП-account role (§2.2). A settlement account is turnover, not your money,
  and `accounts.role` knows only `liquid | investment`. **Decide it before the first sync**, or
  the cushion, the runway and the burn rate all move.

## 5.2 Raiffeisen Bank Aval — measured 2026-08-13

Same shape as PrivatBank, one step worse.

| Route | Who | Gives | Verdict |
|---|---|---|---|
| **Cash Management Open API** (`raiffeisen.ua` → corporate) | corporate clients; onboarding needs a signed application with a qualified digital signature | Account Balance API + **ISO statement API**, OAuth2/JWT, sandbox + UAT + production | Real, but **corporate** — not a personal account, and the entry price is a signed contract |
| **Open banking** (NBU) | NBU-authorised TPPs with a QWAC certificate | personal accounts | Out of reach, exactly as for PrivatBank |
| **MyRaif export** | anyone | statements as **PDF / CSV / XLS**, filterable by period | **This is the path for a personal Raiffeisen account** — and the CSV importer already exists |

**So there is no Raiffeisen provider to write.** The honest work for a personal Raiffeisen account
is not an integration at all — it is making sure the CSV importer reads a MyRaif export cleanly:
the column guesser is hint-based (`HINTS` in `providers/csv.ts`) and has never seen one. That is a
five-minute job **with one real export file in hand** and pure guesswork without it, so it waits
for the file rather than for a decision. The preview screen is designed for exactly this moment: it
shows what it understood before anything is written.

### Reading a real MyRaif export (2026-08-13)

One was handed over, and it did **not** import. Three defects, all now fixed and pinned by two
scenarios in `integrations.test.ts` (with a synthetic copy of the file — the real one carries the
holder's tax id, passport number and address, and a fixture is committed forever):

1. **A statement does not start with its table.** 23 rows of preamble came first — bank details,
   the holder's identity, the account, the period, the totals. The guesser was handed row 0
   (`["Raiffeisen Bank JSC"]`), mapped nothing, and the app declared an ordinary file unreadable.
   → `findHeaderRow` scores each of the first 40 rows by how many columns it can map and takes the
   best; the count of skipped rows is REPORTED in the preview, because a row that vanishes without
   a reason is the one thing this path refuses to do.
2. **The columns are English phrases.** "Details of the operation" matched no hint, so the
   description — the merchant name — came out empty. Hints added, including the exact
   "Amount in card currency", which must beat "Amount in transaction currency" by RULE and not by
   the luck of appearing first (§R2-CUR1: `amount` is in the ACCOUNT's currency).
3. **The timestamps are Kyiv wall clocks**, e.g. `12.06.2026 21:40:00`. This is the §3.2 bug on
   real data: read as UTC, that purchase lands on 13 June. Fixed in step 2; the golden now proves
   it stores as 18:40 UTC = 21:40 Kyiv.

⚠️ **Unverified and worth one more file: the sign of a DEBIT.** The export supplied covers a period
with no expenses (three salary credits), so nothing in it shows how Raiffeisen writes a purchase.
The synthetic fixture assumes a leading minus, which is what the column layout implies — if the
bank instead writes debits unsigned, every purchase would import as INCOME and the totals would
still look plausible. One statement containing a single purchase settles it.

⚠️ Worth noting for later: the Raiffeisen corporate API is **OAuth2**, i.e. a credential that
EXPIRES and must be refreshed. Every credential this app holds today is a static token. That is the
one thing in this document that would need a genuine addition to the model — a refresh path and an
expiry on the connection row — and `bank_connections` is where it would live.

## 6. The general rule this leaves behind

- **Bank support is three tiers, and the product should say which one it is offering:** a push feed
  (mono — real time), a polled feed (Privat ФОП — minutes to hours late), and a file (everyone else
  — as fresh as the last export). CSV is not the poor relation; it is the only path that covers
  every Ukrainian bank today, and it already exists.
- **Nothing about a bank belongs outside its provider file.** Sign conventions, currency letters,
  time zones, pacing, state machines: all of it normalises in `normalizeTx` and nowhere else. Every
  currency bug this project has had came from a second place deciding what a number meant.
- **A new bank must not be able to change existing numbers.** New account, new rows, same canon —
  and if a new account type (a ФОП turnover account) does not belong in the cushion, that decision
  is made before the first sync, not after someone notices their runway moved.

---

## 7. Going international: what English-speaking users actually bank with (researched 2026-08-27)

The goal the owner stated: *eventually a person connects many of their own banks — and one day
crypto — and gets one analytics surface over all of it.* This section is the research behind that,
so the next session does not start from a blank search box. **None of it is built.**

### 7.1 You do not integrate "banks". You integrate ONE aggregator.

The US has ~9 700 institutions with a connection worth having (Chase, Bank of America, Wells
Fargo, Citi, Capital One, US Bank, Ally, SoFi, Navy Federal, plus thousands of credit unions), and
almost none of them publish a public API for a private person — the same wall §1 hit with Privat,
at national scale. Everyone who "supports 10 000 banks" is reselling an aggregator. So the honest
unit of work is **one more `BankProvider` per aggregator**, not per bank — which is exactly the
shape §5 already prepared, and the reason `BankProvider.statement` was made a provider property in
the first place (§BANK-FETCH).

| Provider | Region | Self-serve? | Shape of the deal | Fit here |
|---|---|---|---|---|
| **Teller** | US only | **Yes** | Free developer tier — 100 live connections, unrestricted sandbox; rate-limited, limits undocumented | **Best first move.** Clean REST, no sales call, and 100 connections is more than this app will have for a long time |
| **Plaid** | US · CA · UK · EU (~9.7k institutions) | Sandbox yes, production sales-led | Custom pricing | The coverage everyone compares against; the paperwork arrives with it |
| **SimpleFIN Bridge** | US | **Yes** | ~$15/yr paid by the USER, 25 institutions × 25 apps, read-only, daily refresh | The *self-hosted PFM* answer (Actual, Firefly III both use it). Costs us nothing and the credential is the user's |
| **Enable Banking** | EU/EEA · UK | **Yes** | Free "Restricted Production" for accounts you link yourself, then paid | The replacement for the free tier everyone lost |
| **GoCardless Bank Account Data** (ex-Nordigen) | EU · UK | **No — new signups disabled** | was the free indie tier | Do not plan around it |
| TrueLayer / Tink / Yapily / Salt Edge / MX / Finicity | UK / EU / US | sales-led | enterprise | Only if this ever stops being one person's app |

⚠️ **The read-only distinction is not a detail.** Every option above is account *data*; payment
initiation is a different licence and a different risk profile, and this app has never needed it —
the same line already drawn for the mono token ("it only reads the statement").

### 7.2 What it costs us to add one, in this codebase

Cheaper than it looks, because §BANK-FETCH / §BANK-PARSE / §INGEST-WRITE were built for exactly
this. A new aggregator provider needs: `normalizeTx` (their shape → ours), `statement.fetch` +
pacing, an OAuth-ish **link flow** — and that last one is the genuinely new piece. mono and Privat
are a pasted token; an aggregator is a hosted widget (Teller Connect, Plaid Link) that returns an
`access_token` per *institution*, so one user has N credentials instead of one.

⚠️ **`bankCredential(env, id)` resolves ONE credential per provider (§BANK-CRED).** Multi-bank means
that becomes one per *connection*, and `bank_connections` (which already exists and already has a
row per credential) becomes the key. That refactor is the real cost of this feature — not the HTTP.

⚠️ **A second country breaks two assumptions that are correct today and written down as such:** a
zone-less wall clock is Kyiv (§BANK-PARSE) and a closed budget month is stored in hryvnia
(§BASE-CUR). Neither is wrong now; both are wrong the day a US account arrives. §APP_TZ is the
harder of the two — it is a per-deployment constant, and it would have to become per-user.

### 7.3 Crypto, when it comes

Two different jobs, and conflating them is how crypto trackers get balances wrong:
- **Exchange accounts** — read-only API keys (trading and withdrawal disabled at the exchange).
  The key is the user's; we store it the way `user_secrets` already stores the mono token.
- **On-chain wallets** — a public address is enough, no credential at all. **Zerion API** is the
  live option (self-serve key, wallet holdings + DeFi positions + PnL in one call). ⚠️ **Zapper's
  API shut down on 3 Aug 2026** — do not plan around anything a 2025 blog post recommends.

⚠️ **Crypto is `role: 'investment'`, never the liquid cushion (§R3)** — the split the app already
makes for a brokerage account. A volatile balance counted as runway is a wrong answer that looks
like a feature.

### 7.4 The recommendation, in order

1. **Teller** — self-serve, free, US, and it forces the multi-credential refactor while the app is
   still small enough for that to be cheap.
2. **SimpleFIN** — the cheapest coverage per hour of work, and it fits the "bring your own key"
   posture this app already has everywhere else.
3. **Enable Banking** for the EU, once one aggregator is proven end to end.
4. Plaid only when there is a reason to have the sales conversation.

Sources: openbankingtracker.com (aggregator comparison, free-tier guide), teller.io, GoCardless
Bank Account Data signup notice, zerion.io/api, Zapper shutdown notice.
