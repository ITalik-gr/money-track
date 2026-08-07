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
// check only fires for object literals — and most handlers spread a row from `repo/`. Measured on
// the fixture: `GET /transactions` puts 38 fields on the wire while `TxRow` names 28, so a
// quarter of that response is undeclared (`raw_json`, `ai_note`, `alerted`, …). Card in
// ROADMAP.md. If you need "nothing else", the check has to be a golden, not a type.
export * from "./accounts.ts";
export * from "./ai.ts";
export * from "./analytics.ts";
export * from "./planning.ts";
export * from "./platform.ts";
export * from "./transactions.ts";
