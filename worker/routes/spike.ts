// P0.0 SPIKE — TEMPORARY. Delete together with the SPIKE_DB binding and worker/do/spike-*.ts
// once the shim is proven and the conclusion is written into PLATFORM.md §10.
//
// Question it answers: can the SQLite inside a Durable Object be exposed through a facade
// that behaves like `env.DB`, so the canonical SQL of `lib/stats.ts` runs UNCHANGED against
// either backend? Only a run can answer that, so this route seeds one fixture into a scratch
// D1 and into a DO, executes the same statements against both, and diffs the JSON.
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { MIGRATIONS } from "../do/migrations.generated.ts";
import { splitSqlStatements } from "../do/sql-split.ts";
import { SPIKE_FIXTURE_SQL } from "../do/spike-fixture.ts";
import { probe } from "../do/spike-probe.ts";
import type { AppDb } from "../lib/db-shim.ts";

export const spike = new Hono<{ Bindings: Env }>();

/** Applies the embedded migrations to a real D1 database, statement by statement. */
async function migrateD1(db: D1Database): Promise<{ applied: number; error?: string }> {
  await db
    .prepare("CREATE TABLE IF NOT EXISTS _mt_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")
    .run();
  const done = new Set(
    (await db.prepare("SELECT name FROM _mt_migrations").all<{ name: string }>()).results.map((r) => r.name),
  );
  let applied = 0;
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    try {
      // D1's `exec()` demands one statement per line, which no real migration file satisfies,
      // so the file is fed statement by statement instead.
      for (const stmt of splitSqlStatements(m.sql)) await db.prepare(stmt).run();
      await db.prepare("INSERT INTO _mt_migrations (name, applied_at) VALUES (?, ?)").bind(m.name, Date.now()).run();
      applied++;
    } catch (e) {
      return { applied, error: `${m.name}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { applied };
}

/** Structural diff, so the report names the exact key that disagrees. */
function diff(a: unknown, b: unknown, path = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return [`${path}: D1=${JSON.stringify(a)} DO=${JSON.stringify(b)}`];
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  const out: string[] = [];
  for (const k of keys) {
    out.push(
      ...diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k),
    );
  }
  return out;
}

spike.get("/db", async (c) => {
  const report: Record<string, unknown> = {};

  // --- D1 reference backend ------------------------------------------------------------
  const d1 = c.env.SPIKE_DB;
  const d1Migration = await migrateD1(d1);
  report["d1_migration"] = d1Migration;
  if (d1Migration.error) return c.json({ ...report, verdict: "D1 migration failed" }, 500);
  for (const stmt of splitSqlStatements(SPIKE_FIXTURE_SQL)) await d1.prepare(stmt).run();
  // Remove rows earlier probe runs created, so repeated runs stay identical.
  await d1.prepare("DELETE FROM categories WHERE name = 'SpikeCat'").run();
  await d1.prepare("DELETE FROM transactions WHERE id IN ('tx_fk_probe','tx_batch_a','tx_batch_b')").run();

  // --- DO backend ------------------------------------------------------------------------
  const stub = c.env.USER_DO.get(c.env.USER_DO.idFromName("spike-user"));
  await stub.reset();
  report["do_migration"] = await stub.migrationReport();
  await stub.script(SPIKE_FIXTURE_SQL);

  // --- same probe, two backends -----------------------------------------------------------
  const d1Out = await probe(d1 as unknown as AppDb);
  const doOut = await stub.spikeProbe();

  const differences = diff(d1Out, doOut);
  return c.json({
    ...report,
    verdict: differences.length === 0 ? "IDENTICAL" : `${differences.length} difference(s)`,
    differences,
    d1: d1Out,
    do: doOut,
  });
});
