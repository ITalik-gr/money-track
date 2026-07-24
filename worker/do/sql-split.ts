// Splits a .sql migration file into individual statements.
//
// Needed only for the D1 side of the P0.0 spike: D1's `exec()` requires every statement to
// sit on a single line, which no real migration file does, so the file has to be fed
// statement-by-statement through `prepare().run()`. The DO side does not need this —
// `SqlStorage.exec` accepts a multi-statement script as long as there are no bind params.
//
// The splitter is quote-aware rather than a naive `split(";")` because a semicolon inside a
// string literal would otherwise cut a statement in half. It is intentionally NOT a general
// SQL parser: `CREATE TRIGGER … BEGIN … END;` bodies would break it. That is safe here and
// checked — this repo's migrations contain zero triggers (verified 2026-07-24); add trigger
// support the day one appears.
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  let lineComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
        buf += ch;
      }
      continue;
    }
    if (quote) {
      buf += ch;
      // SQL escapes a quote by doubling it ('' inside '…'), so a doubled quote stays inside.
      if (ch === quote) {
        if (next === quote) {
          buf += next;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "-" && next === "-") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch as "'" | '"';
      buf += ch;
      continue;
    }
    if (ch === ";") {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = "";
      continue;
    }
    buf += ch;
  }

  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}
