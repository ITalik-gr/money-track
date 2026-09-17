/**
 * The body of an uncaught 500 — who may read the raw cause (2026-09-17).
 *
 * The rule in CLAUDE.md «Обробка помилок» shipped the raw message on purpose, so a failure is
 * diagnosable from the screen instead of `[object Object]`, and it came with a stated trigger:
 * hide it once people outside the owner's circle use the app. Registration has been open since
 * 2026-07-31, so the trigger has fired. A raw message can carry SQL, table and column names, and
 * internal paths — nothing a stranger needs, and a map for anyone probing.
 *
 * The owner still sees everything. Everyone else sees `internal_error` and a short `ref`, which
 * is also written to the log line, so a screenshot sent to the owner leads straight to the cause.
 */
export function errorBody(
  err: unknown, method: string, path: string, isOwner: boolean,
): { body: { error: string; detail: string }; ref: string; msg: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const ref = crypto.randomUUID().slice(0, 8);
  const body = isOwner
    ? { error: msg || "internal_error", detail: `${method} ${path} · ref ${ref}` }
    : { error: "internal_error", detail: `ref ${ref}` };
  return { body, ref, msg };
}
