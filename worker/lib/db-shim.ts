// A D1-shaped facade over the SQLite database that lives inside a Durable Object.
//
// WHY THIS EXISTS (the whole point of the multi-user migration):
// The analytics canon — `lib/stats.ts` and every query built on STATS_JOINS / SPEND_WHERE /
// EFF_AMOUNT — is plain SQL text handed to `env.DB.prepare()`. Moving each user into their
// own Durable Object must NOT rewrite that text. Rewriting it is exactly how the canon
// drifts and screens start disagreeing with each other (see the §SPLIT regression in
// CLAUDE.md: five queries lost STATS_JOINS and the whole Statistics page went silently
// empty). So we port the *interface*, not the queries: this facade mimics the small slice
// of the D1 API the app actually uses, and every SQL string stays byte-identical.
//
// It deliberately implements a NARROW surface (`AppDb` below) rather than all of
// `D1Database`. That is a check, not a limitation: `Env["DB"]` is typed as `AppDb`, so if
// someone reaches for a D1 feature the DO cannot provide (sessions, `dump()`, `.raw()`),
// `tsc` fails at the call site instead of the code failing in production for one user.

/** Result row set, shaped like `D1Result`. `D1Result` is structurally assignable to this. */
export interface AppResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: {
    /** Rows actually inserted/updated/deleted by the statement (SQLite `changes()`). */
    changes: number;
    /** Rowid of the last insert. `notify.ts`/`receipt.ts`/`report.ts` read this. */
    last_row_id: number;
  };
}

export interface AppPreparedStatement {
  bind(...values: unknown[]): AppPreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T = unknown>(colName: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<AppResult<T>>;
  run<T = Record<string, unknown>>(): Promise<AppResult<T>>;
}

/**
 * The database surface the application is allowed to use. Both the real `D1Database` and
 * `DoDatabase` below satisfy it, which is what makes the swap in the request middleware
 * a one-line change instead of ~427 call-site edits.
 */
export interface AppDb {
  prepare(query: string): AppPreparedStatement;
  batch<T = Record<string, unknown>>(statements: AppPreparedStatement[]): Promise<AppResult<T>[]>;
}

// ---------------------------------------------------------------------------------------

/**
 * Statement bound to a DO's `SqlStorage`.
 *
 * `bind()` returns a NEW instance rather than mutating: D1 prepared statements are
 * immutable and code in this repo relies on it (a base statement is prepared once and
 * `.bind()`-ed per row when building a `batch`).
 */
class DoStatement implements AppPreparedStatement {
  constructor(
    private readonly sql: SqlStorage,
    private readonly query: string,
    private readonly values: unknown[],
  ) {}

  bind(...values: unknown[]): AppPreparedStatement {
    return new DoStatement(this.sql, this.query, values);
  }

  async all<T = Record<string, unknown>>(): Promise<AppResult<T>> {
    return this.execSync<T>();
  }

  async run<T = Record<string, unknown>>(): Promise<AppResult<T>> {
    return this.execSync<T>();
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const rows = this.execSync<Record<string, unknown>>().results;
    if (rows.length === 0) return null;
    const row = rows[0]!;
    // D1's `first("col")` returns the bare value, not the row — several call sites depend
    // on that overload (e.g. `first<number>("n")` on a COUNT).
    if (colName !== undefined) return (row[colName] ?? null) as T | null;
    return row as T;
  }

  /**
   * Runs the statement. Public-but-internal: `DoDatabase.batch` needs a synchronous entry
   * point because `transactionSync` cannot await.
   */
  execSync<T = Record<string, unknown>>(): AppResult<T> {
    const cursor = this.sql.exec(this.query, ...(this.values as SqlStorageValue[]));

    // Drain eagerly. DO cursors stream from the database and are invalidated as soon as the
    // next `exec()` runs on the same storage; D1 hands back a materialised array, and the
    // app assumes D1's behaviour (results are held, iterated later, passed around).
    const results = cursor.toArray() as T[];

    // `rowsWritten` counts physical row writes INCLUDING index rows, so it is not the same
    // number as SQLite's `changes()` — it is only used here as a cheap "was this a write?"
    // gate. The exact count comes from `changes()`, which is what `notify.ts` uses to tell
    // "INSERT OR IGNORE actually inserted" from "the dedup_key already existed".
    // Reading `changes()`/`last_insert_rowid()` via a SELECT does not reset them.
    let changes = 0;
    let lastRowId = 0;
    if (cursor.rowsWritten > 0) {
      const meta = this.sql
        .exec<{ c: number; r: number }>("SELECT changes() AS c, last_insert_rowid() AS r")
        .one();
      changes = Number(meta.c) || 0;
      lastRowId = Number(meta.r) || 0;
    }

    return { results, success: true, meta: { changes, last_row_id: lastRowId } };
  }
}

/** `env.DB` replacement backed by the calling Durable Object's own SQLite database. */
export class DoDatabase implements AppDb {
  constructor(private readonly ctx: DurableObjectState) {}

  prepare(query: string): AppPreparedStatement {
    return new DoStatement(this.ctx.storage.sql, query, []);
  }

  async batch<T = Record<string, unknown>>(statements: AppPreparedStatement[]): Promise<AppResult<T>[]> {
    // D1 runs a batch as a single implicit transaction. `transfers.ts` and the bulk endpoints
    // depend on that atomicity: a half-applied transfer pairing would leave one side of a
    // pair pointing at a `transfer_pair_id` the other side never got, and the list would
    // then hide a row whose partner does not exist.
    return this.ctx.storage.transactionSync(() =>
      statements.map((s) => (s as DoStatement).execSync<T>()),
    );
  }
}
