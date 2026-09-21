# ROADMAP — live task queue

> **Only what is still to do.** Done work is DELETED from here, not ticked. Durable rule →
> the matching `docs/*.md` + a line in the § index of `CLAUDE.md`; design decision → the
> decision log in `DESIGN.md`. Take the top card; read the domain docs first; `npm run check` +
> `npm run build` before "done". Live checks are the owner's and do not go into the queue.
>
> Card format: `### Title` · **Goal** (what will be true) · **Files** · **Steps** (2–5,
> checkable) · **Done-when** (checkable without discussion). One line from the owner is enough —
> the model expands it before starting.

## 🔥 Queue — blocked on the OWNER's eye

### 13 modifier classes that do nothing
Listed in `STYLELESS_OK` (`scripts/check-styles-used.mjs`): `advisor-main`, `pulse-cats`,
`top-subs-card`, `lp-top-signin`, `goal-jar`, `tip-net`, `alt`… Each is a leftover or an unfinished
intent — only a live screen tells which. The list must shrink, never grow.

### STYLES phases 0.5 + 4 (`DESIGN.md §8`)
Phase 0.5: 8 selectors that silently conflict — today's render is their unwritten merge, so
collapsing them changes the render. Phase 4: real domain grouping across cascade boundaries.
**Done-when:** the 8 conflicts are resolved against live screens with no unapproved visual change.

### MCP for a second assistant (ChatGPT) — live connection
Everything is built against the specs and pinned in `oauth.test.ts` (§MCP-OAUTH).
**Done-when:** ChatGPT connects without edits to `chat-tools.ts`; any edit needed is recorded here.

## 🔨 Build (self-contained)

### Jev (TypeSafe) — after phase 4
`AI_JUDGE = "jev"` is on, owner-only.
- More held-out cases in `worker/test/__eval__/sites.json` BEFORE any line moves — the
  §SUB-REVIEW lines (0.5 / 0.4) sit in a 0.1-wide gap measured on 20 merchants.
- Search rerank: re-measure on a newer Jev (`node scripts/eval-sites.mjs --site search`); wire into
  `appendSemantic` only when a line separates «shown» from «hidden» (§7.4).
- Other users: a per-user TypeSafe key through `user_secrets` (§10).
- `known_plan`: only with a real case whose bank name differs from the plan's.

### SQLite `LOWER() LIKE` with Cyrillic — two more sites
SQLite folds case for ASCII only, so `LOWER(x) LIKE '%київстар%'` misses «Київстар». Fixed in
`linkPlanHistory`; still in `consensusCategory` (`enrich.ts`) and `repo/transactions.ts:888`.
Fix: filter by something script-free in SQL, match the name in JS. A lint could flag `LOWER(`
next to `LIKE` in worker SQL.

### Batch runs — wire a real job kind
The mechanics exist (§A6-BATCH, migration 0053, pinned on `noop_batch`). Left: hang
`enrichPending` on it as its own job kind with its own `NotifKind` and template. Needs the owner's
live key — the paid payload cannot be tested otherwise.

## 📌 Backlog

### ФОП — audit A1 findings (each needs a canon decision)
- **Money returned to a client does not reduce the quarter's income** — `INCOME_WHERE` requires
  `t.amount > 0`. Safe direction (overstates the tax). Needs a §REFUND-like rule for income: a
  return in the SAME period reduces it, a later one does not reopen the closed quarter (`repo/tax.ts`).
- **A future-dated business receipt is taxed but not counted against the annual ceiling** —
  quarter window `[quarterStart, nextQuarter)` vs limit window `[yearStart, now)`; one must win.
- **The limit's pace has no minimum window** — `daysElapsed = max(1, …)`, so one receipt on
  1 January projects crossing the ceiling on the 11th. Should ask §CADENCE.

### Banks
- **Privat is not verified on the live API** (no ФОП account, no sandbox) — expect one round of
  fixes: the `ID` parameter and balance field names.
- **Decide BEFORE the first Privat sync:** a ФОП account is turnover, not your money, and
  `accounts.role` knows only `liquid|investment` — without a third value the sync shifts cushion,
  runway and burn.
- **Revoked operations:** a row stored as `p` (pending) that later got reversed stays stored — the
  canon has no «cancelled» state. Do with a live account.

### Many banks, one analytics
- Pick an aggregator: **Teller** → **SimpleFIN** → **Enable Banking** (EU) → Plaid.
  GoCardless/Nordigen's free tier is closed to new users.
- The real cost is `bankCredential(env, id)` (§BANK-CRED): one credential per provider, while an
  aggregator has one per institution. `bank_connections` already has the right shape.
- Two assumptions break on the first foreign account: naive wall time is Kyiv (§BANK-PARSE), and a
  closed budget month is stored in hryvnia. §APP_TZ must become per-user.
- Crypto: exchanges = read-only API keys; on-chain = public address via **Zerion** (Zapper closed
  2026-08-03). Always `role: 'investment'`.

### Multi-provider AI (deferred)
Anthropic / OpenAI / Grok. Diverges in tool use (`runToolConversation`), the prompt cache
(`cache_control ttl:1h` — §A5 economics), server `web_search`, `priceFor`. Cheap path: an adapter
for one-shot calls only, agentic chat stays on Anthropic. The seam is `worker/lib/ai/json.ts`.
⚠️ `demoClamp` knows only Anthropic models.

### AI 4.0 tails
- User upload of PDF/MD into the knowledge corpus (R2 + D1).
- Native PDF `document` block + `citations`.
- `output_config.format` (structured outputs) instead of `repairTruncatedJson`.

### Other
- Lazy-enrich (option B) — on agreement.

## 🎨 Design — future (`DESIGN.md §7`)
- Statistics: redesign of Overview + Categories/Trends — needs a live screenshot.
- Checklist for a page reviewed live: local hardcoded colour / shadow / `transition:all` / cramping.
- Layout above 1920px.

## 💡 Feature ideas (for triage)
- **Smart goal challenges (S)** — AI proposes a realistic challenge («−15% on delivery = +1200 ₴»)
  and tracks it.
- **FX impact as its own figure (S)** — split net-worth change into «money moved» vs «rate moved»
  (`rate_history` exists); worth it once several months accumulate.
- **Dashboard smoothness (S)** — finish existing animations, remove jank.
