/**
 * §CYR-CASE — matching text in SQLite when the text is Ukrainian.
 *
 * SQLite folds case for ASCII ONLY: `LOWER('Сільпо')` is still `'Сільпо'` (verified on D1), and
 * `LIKE` is case-insensitive for ASCII only. So `LOWER(x) LIKE '%сільпо%'` never finds «Сільпо»,
 * and never finds «СІЛЬПО» — which is how banks write it. D1 offers no Unicode collation, so the
 * fold happens HERE, in JS (which is Unicode-aware), and SQL receives the spellings that actually
 * occur, OR-matched.
 *
 * One definition, 2026-09-25. There were two: `export.ts` (search) built four spellings, while
 * `repo/planning.ts` built three and left out UPPER CASE — so a plan search for «київстар» missed
 * «КИЇВСТАР» on exactly the rows a bank writes. And two sites (`consensusCategory`, `findSimilar`)
 * still used `LOWER(x) LIKE`, which lint C16 now refuses in worker SQL.
 *
 * Deliberately not covered: mixed case inside a word («МакДональдз» for «макдональдз») — the
 * price of matching it would be scanning the table in JS on every call.
 */
export function caseVariants(term: string): string[] {
  const low = term.toLocaleLowerCase("uk");
  return [...new Set([
    term,
    low,
    term.toLocaleUpperCase("uk"),
    low.charAt(0).toLocaleUpperCase("uk") + low.slice(1),
  ])];
}

/** `caseVariants` wrapped for `LIKE '%…%'`. */
export function likeVariants(term: string): string[] {
  return caseVariants(term).map((v) => `%${v}%`);
}

/**
 * `(col LIKE ? OR col LIKE ? …)` for every spelling, and the binds that go with it — so a caller
 * cannot build the clause for one list and bind another.
 */
export function orLikeClause(cols: string[], term: string): { sql: string; binds: string[] } {
  const likes = likeVariants(term);
  const parts: string[] = [];
  const binds: string[] = [];
  for (const col of cols) for (const l of likes) { parts.push(`${col} LIKE ?`); binds.push(l); }
  return { sql: `(${parts.join(" OR ")})`, binds };
}
