// The client↔worker API contract, in one place (phase 2 of ARCHITECTURE.md, defect D2).
//
// Before this existed, `shared/types.ts` was imported by ZERO worker files: the "shared" types
// were shared in name only. The client hand-declared 86 types describing what it believed the
// server returned, the worker declared its own inline via `.all<{…}>()`, and `tsc` saw two
// independent truths it could not reconcile — so drift surfaced only in production.
//
// The guarantee does NOT come from generation (decision 5 in ARCHITECTURE.md): a build step and
// an opaque artefact in a public repo buy nothing here. It comes from the worker ANNOTATING its
// return with these types while the client imports the same ones. Then a field renamed on either
// side is a compile error, with no tooling to keep alive.
//
// Files mirror `worker/routes/api/*` so "where does this response live" has one answer.
//
// ⚠️ **A contract type is a FLOOR, not a ceiling.** `satisfies` proves every declared field is
// produced; it does NOT prove the response contains nothing else, because the excess-property
// check only fires for object literals — and most handlers spread a row from `repo/`. This was
// measured, not theorised: `GET /transactions` used to put every column of the table on the wire
// while `TxRow` named 21 of them, so a quarter of the response was fields only the detail screen
// reads — `raw_json` above all, which on a real bank operation is the entire payload, shipped on
// every row of a list that never shows it. Fixed 2026-08-07 by naming the columns (`FEED_COLUMNS`
// in `repo/transactions.ts`), and the golden is what holds it: **if you need "nothing else",
// the check has to be a golden, not a type.**
export * from "./accounts.ts";
export * from "./ai.ts";
export * from "./analytics.ts";
export * from "./backups.ts";
export * from "./chats.ts";
export * from "./feedback.ts";
export * from "./insights.ts";
export * from "./planning.ts";
export * from "./platform.ts";
export * from "./rules.ts";
export * from "./push.ts";
export * from "./transactions.ts";
