/**
 * In-process test harness: runs the REAL route handlers against a REAL schema, in Node.
 *
 * Why this is possible at all — and why it is the right shape for characterization tests:
 *
 *   The multi-user migration already introduced `AppDb` (`lib/platform/db-shim.ts`), a narrow
 *   facade over the small slice of the D1 API the app actually uses. Production has two
 *   implementations behind it (real D1, and a Durable Object's SQLite). This is a third. Because
 *   the canon is plain SQL text handed to `prepare()`, the queries under test here are
 *   byte-identical to the ones that run in production — which is the whole point. A harness that
 *   re-declared them would only prove the copy agrees with itself.
 *
 * The schema comes from `migrations/*.sql`, not from a hand-written CREATE TABLE. A fixture
 * schema that drifts from the real one turns green tests into a lie exactly when a migration
 * changes something — which is when you need them most.
 *
 * Time is frozen by overriding `Date.now`. `stats.ts` already takes `now` as a defaulted
 * parameter, and `routes/api.ts` calls those helpers without it, so freezing the clock makes
 * every period boundary deterministic WITHOUT touching production code. That constraint matters:
 * these tests exist to prove a refactor changed nothing, so they must not require the refactor
 * to start.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations");

/** Statement bound to an in-memory SQLite database, shaped like a D1 prepared statement. */
class MemStatement {
  // Plain fields, not constructor parameter properties: Node's type-stripping runs this file
  // directly and rejects that syntax.
  readonly db: DatabaseSync;
  readonly query: string;
  readonly values: unknown[];

  constructor(db: DatabaseSync, query: string, values: unknown[] = []) {
    this.db = db;
    this.query = query;
    this.values = values;
  }

  // Returns a NEW instance rather than mutating: D1 statements are immutable and code in this
  // repo relies on it (a base statement prepared once, `.bind()`-ed per row to build a batch).
  bind(...values: unknown[]): MemStatement {
    return new MemStatement(this.db, this.query, values);
  }

  private exec(): { results: Record<string, unknown>[]; changes: number; lastRowId: number } {
    const stmt = this.db.prepare(this.query);
    // Integers wider than 2^53 would otherwise come back as BigInt and break JSON comparison.
    // Money here is minor units and never approaches that, so plain numbers are the honest read.
    stmt.setReadBigInts(false);
    const params = this.values.map(norm);
    // node:sqlite refuses `all()` on a non-SELECT, so route by what the statement returns.
    if (/^\s*(select|with|pragma)/i.test(this.query)) {
      return { results: stmt.all(...params) as Record<string, unknown>[], changes: 0, lastRowId: 0 };
    }
    const info = stmt.run(...params);
    return { results: [], changes: Number(info.changes ?? 0), lastRowId: Number(info.lastInsertRowid ?? 0) };
  }

  private result<T>(): { results: T[]; success: true; meta: { changes: number; last_row_id: number } } {
    const r = this.exec();
    return { results: r.results as T[], success: true, meta: { changes: r.changes, last_row_id: r.lastRowId } };
  }

  async all<T = Record<string, unknown>>() { return this.result<T>(); }
  async run<T = Record<string, unknown>>() { return this.result<T>(); }

  // D1's `first("col")` returns the bare value, not the row — several call sites depend on that
  // overload (e.g. `first<number>("n")` on a COUNT).
  async first<T = unknown>(colName?: string): Promise<T | null> {
    const rows = this.exec().results;
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return (colName === undefined ? (row as T) : ((row[colName] ?? null) as T));
  }
}

/** `undefined` is not a bindable SQLite value; D1 treats a missing param as NULL. */
function norm(v: unknown): null | number | string | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  if (v instanceof Uint8Array) return v;
  return String(v);
}

export class MemDb {
  readonly raw: DatabaseSync;
  constructor(raw: DatabaseSync) { this.raw = raw; }
  prepare(query: string) { return new MemStatement(this.raw, query); }
  async batch<T = Record<string, unknown>>(statements: { all(): Promise<unknown> }[]) {
    const out: T[] = [];
    for (const s of statements) out.push((await s.all()) as T);
    return out as never;
  }
}

/** Fresh database with every real migration applied, in filename order. */
export function migratedDb(): MemDb {
  const d = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    d.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  return new MemDb(d);
}

/**
 * Freeze the clock. Returns a restore function.
 *
 * A fixed instant is chosen by the caller and stored alongside the golden files: mid-month and
 * mid-week, so "period to date" has both elapsed and remaining days on every preset. A boundary
 * instant would make a whole class of off-by-one bugs invisible.
 */
export function freezeTime(iso: string): () => void {
  const fixed = new Date(iso).getTime();
  const realNow = Date.now;
  Date.now = () => fixed;
  return () => { Date.now = realNow; };
}

/**
 * Make `crypto.randomUUID` deterministic. Returns a restore function.
 *
 * Needed only by the WRITE tests: `/transactions/transfer` mints ids and a `transfer_pair_id`
 * itself, and a random pair id would change the snapshot on every run. Sequential ids keep the
 * golden file stable while still proving the two legs share one pair — which is the invariant
 * that matters (§Інваріанти: a transfer is a PAIR, not a flag).
 */
export function freezeUuid(): () => void {
  let n = 0;
  const real = crypto.randomUUID;
  crypto.randomUUID = (() =>
    `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`) as typeof crypto.randomUUID;
  return () => { crypto.randomUUID = real; };
}

/** Minimal `Env` for read-only route tests: analytics touches the database and nothing else. */
export function testEnv(db: MemDb): Record<string, unknown> {
  return {
    DB: db,
    USER_ID: "test-user",
    IS_OWNER: "1",
    // Deliberately no API keys: an analytics route that starts calling a model should fail the
    // test loudly rather than quietly reach the network.
  };
}
