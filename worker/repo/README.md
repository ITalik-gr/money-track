# `worker/repo` — the only layer that talks to the database

Every `.prepare()` in the request path belongs here. `scripts/check-repo-layer.mjs` enforces it
for `worker/routes/**`, and `npm run check` runs that script.

## Why this layer exists

Four of the most expensive bugs in this project share one mechanism:

| Bug | What happened |
|---|---|
| §CUR-PLAN | five places summed `period_amount` raw — a $5 subscription weighed 5 ₴ |
| §SUB-MONTH | sums never normalised the period — the app showed **two different totals for the same subscriptions** |
| §REFUND | `INCOME_WHERE` was just `amount > 0` — income was overstated on real data |
| §SPLIT | a query used a canonical helper without `STATS_JOINS` — Statistics silently went blank |

None of them was a typo. All four are the same story:

> a query lived inline in a handler → nothing else could import it → the next feature wrote its
> own → now "spending" had two definitions → they drifted, silently, because SQL is a string and
> `tsc` cannot see inside it.

Moving the queries out fixes that once. The linter is what keeps it fixed.

## Shape

```
routes/     transport: parse the request, validate, choose a status code, serialise
   ↓        (a handler should read as 5–15 lines)
services/   scenarios: orchestration, transactionality, permissions
   ↓
lib/        domain logic — the canon (`lib/finance/stats.ts`) lives here
   ↓
repo/       SQL, and nothing else
```

## Conventions

- **Take `AppDb`, not `Env`.** The narrower dependency makes a repo function callable straight
  from a test, and it keeps the layer honest: a function that needed the whole environment would
  be doing more than fetching rows.
- **Return domain values, not `D1Result`.** Callers should get `Account[]`, not `{ results }`.
- **Parsing stays in the route; the query stays here.** `?amin=` arrives as a string in ₴ — the
  route coerces it to minor units, the repo decides how a filter becomes SQL.
- **Do not translate on read.** Category names come back as stored. Resolving them is the
  caller's job (`localizeCatName`), because a repo that renamed rows would silently rewrite
  names the user typed themselves.
- **Distinguish "nothing found" from "cannot answer".** `balanceHistory` returns `null` when its
  table has not been migrated yet, because the caller must answer differently than for an
  account with no history.
- **Canonical money SQL is still owned by `lib/finance/stats.ts`.** Repo functions compose
  `STATS_JOINS` / `SPEND_WHERE` / `amountSum()`; they never restate what those mean.

## Migration status

`api.ts` began with 179 inline queries. The budget in `scripts/check-repo-layer.mjs` is a
ratchet: it may never rise, and when the real count drops the budget must be lowered to match or
the build fails. That keeps a stale allowance from quietly permitting new debt.
