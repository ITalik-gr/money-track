# Contributing

Thanks for looking at Money Track. This is a personal project run by one maintainer, so the bar
here is less "follow the process" and more "understand why the invariants exist before moving
them" — most of them were bought with a production bug.

## Before you start

Read **`CLAUDE.md`** first — it is the entry point: stack, code map, the hard invariants and an
index of every § rule pointing at the `docs/` file that explains it. It covers how statistics are
canonically defined, the security model, and ops. For anything touching UI, read **`DESIGN.md`**
first instead — it owns the design tokens and carries a decision log.

`ROADMAP.md` is the live queue of what still needs doing. `ARCHITECTURE.md` states the target
layering (`routes → services → lib → repo`) and what each check C1–C10 buys.

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in what you need; all values are optional to boot
npm run db:migrate:local
npm run db:seed:local            # optional sample data
npm run dev
```

Use **`npm run dev`** (Vite). Do not use `wrangler dev` for local checks — it reads a stale
redirected config from `dist/` and won't see new bindings, which shows up as "the route isn't
registered" when the route is fine.

## The green bar

Nothing is "done" until both pass:

```bash
npm run check    # tsc (app + worker) + SQL / i18n / layer / size lints + migration embed + tests
npm run build
```

`npm run check` is not just a type check. It also enforces things the type system cannot see:

- **SQL lint** — a query using a canonical helper (`amountSum`, `SPEND_WHERE`, `EFF_*`) must also
  include `STATS_JOINS`. SQL is a string, so `tsc` is blind to it; without this lint the failure
  is a runtime `no such column: sp.amount`.
- **Layer lint (C1)** — `.prepare()` belongs in `worker/repo/`. `worker/routes/` carries a
  ratcheting budget that may only fall (10 queries left, all on ingest paths); `worker/services/`
  has no budget at all. This is the check that keeps "I'll just write the query here" from
  re-creating the four most expensive bugs in the project.
- **File size (C3)** — no file under `worker/routes/` or `worker/services/` exceeds 400 lines,
  bar two recorded exceptions that may never rise. `api.ts` reached 3 331 lines one small append
  at a time; splitting it once would not have kept it split.
- **API contract (C2/C4)** — every response shape is declared ONCE, in `shared/api/`. The client
  imports and re-exports it; the worker annotates its returns with it. `src/store/api.ts` may not
  declare a type of its own, and `repo/`/`services/` may not describe a row as
  `Record<string, unknown>` or with an `[key: string]: unknown` hatch. Before this, the client
  hand-wrote 86 shapes describing what it *believed* the server sent, and `tsc` could not compare
  them with anything.
- **i18n lint** — `en`/`uk` key parity, and no hardcoded locale tags. Never construct `new Intl.*`
  directly; use `dateFmt()` / `numFmt()` from `src/i18n/locale.ts`, or a module-level formatter
  will freeze the locale at import time.
- **Migration embed** — if you change `migrations/*.sql`, regenerate the Durable Object embed with
  `node scripts/gen-migrations.mjs`, or the migration silently never reaches user databases.

## Rules that are not negotiable

These exist because breaking them has already cost real money in wrong numbers:

1. **Money is INTEGER minor units** everywhere. Divide by 100 only when displaying.
2. **All money math goes through `worker/lib/finance/stats.ts`.** If you need a new number, add it
   there — do not write a second query that means almost the same thing. Every expensive bug in
   this project came from a *second* place deciding what a number meant.
3. **Layering:** `routes/*` is transport and validation, `services/*` holds multi-step scenarios,
   `lib/*` holds the domain logic and `repo/*` is the only layer that issues SQL. Route modules
   live in `routes/api/<first-path-segment>.ts`, so one file owns a whole prefix — that is what
   makes the literal-before-parameterised rule readable in one file. No SQL in components.
4. **A response shape is declared once, in `shared/api/`**, and BOTH sides use that declaration.
   A type that only the client imports is not a contract; it is a guess with syntax.
5. **Verification beats instruction.** If correctness depends on a developer or a model
   remembering something, add a deterministic check instead. That is what the SQL lint and
   `numbersAreGrounded()` are.
6. **Anything that looks like a global resource is actually the owner's** (bank token, AI key,
   webhook secret, Telegram chat). Gate it on `env.IS_OWNER`. This has been the source of two
   cross-tenant leaks.

## Comments

Write comments in **English** in new code. Existing Ukrainian comments are not being mass-migrated
— they carry nuance about *why* — but new code and files you're already editing should be English.

Comment the **why**, not the what: which alternative was rejected, which bug this closes, which
invariant it holds. Required next to canonical code, next to workarounds for third-party quirks,
and next to any check that exists because something once failed.

## Pull requests

One logical change per PR. Include what you verified and what you didn't. If your change touches a
number the UI or the AI displays, say which existing figure you compared against — "the numbers
still look right" is not a check.

## Reporting bugs and vulnerabilities

Ordinary bugs → GitHub issues. Security problems → **do not** open an issue; see `SECURITY.md`.
