/**
 * Does the fixture actually contain the schema?
 *
 * This test exists because of the single largest finding of 2026-08-21. `currency-sweep.test.ts`
 * verifies that every money field in every response halves when the display base does — a strong,
 * mechanical check, and it was passing **vacuously** over five money-carrying tables, because
 * fourteen tables had no fixture rows at all and **an absent field cannot leak**. Two real bugs
 * were hiding behind that: `budget_history` returning raw hryvnia into a converted card, and
 * `autofill_value` converting in neither direction.
 *
 * Fixing those two was the easy half. The hard half is that the blind spot could come back through
 * any new table, silently, and the sweep would keep reporting success. So the coverage itself is
 * now asserted: a table with no rows must be NAMED here, with a reason, and the name is reviewable
 * in a way that silence never was.
 *
 * ⚠️ This is deliberately about the tables, not about the columns. A column-level version would
 * be stricter and would also be a second schema to maintain — and the failure it would catch is
 * rarer than the one that actually happened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migratedDb, migratedDirectoryDb, freezeTime, type MemDb } from "./harness.ts";
import { seed, seedRareTables, FROZEN_NOW_ISO } from "./fixture.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Tables allowed to be empty, each with the reason.
 *
 * A name here is a CLAIM — "no read path of ours can misreport this table's contents, because it
 * has no contents in any account until a feature is used". Adding one is a decision somebody can
 * disagree with in review, which is the whole difference from an unlisted table.
 */
const EMPTY_OK: Record<string, string> = {
  // Written only by a live integration or a user action, and read back through paths whose
  // correctness does not depend on the values (ids, blobs, timestamps).
  user_secrets: "encrypted credentials — a fixture value would be meaningless ciphertext",
  push_subscriptions: "browser endpoints; §PUSH deliberately stores no payload keys",
  knowledge_docs: "the §A5 corpus is loaded from files, not from fixture rows",
  bank_connections: "written per sync attempt; covered by backfill.test.ts with its own fixture",
  rate_history: "the sweep sets `app_state.rates` directly; fx-cost.test.ts drives history itself",
  // Job and audit trails: their read paths return ids and timestamps, never money.
  ai_jobs: "queue rows; jobs.test.ts builds its own",
  ai_changes: "§AI-AUDIT trail — old/new values are TEXT, and writes.test.ts covers them",
  // Conversations: prose, no money fields at all.
  chats: "§CHAT-SYNC conversations; writes.test.ts covers them",
  chat_messages: "same",
  // Bookkeeping the migration runner owns.
  migrations: "the migration ledger itself",
  _cf_KV: "Durable Object internals, not ours",
  // Learned/derived rows whose read paths return names and ids, never amounts. Each has its own
  // focused suite that seeds what it needs (`similar.test.ts`, `writes.test.ts`).
  merchant_aliases: "learned category per merchant — a name-to-id map, no money",
  transaction_tags: "secondary category ids; they do not sum (§6)",
  planned_dismissed: "a set of dismissed suggestions; ids only",
  ai_reports: "stored report JSON — reports.test.ts builds its own, and the fixture cannot fake a model",
};

/** Directory tables — a separate database, so a separate (shorter) list. */
const DIR_EMPTY_OK: Record<string, string> = {
  users: "identity; tg-links.test.ts and demo-tally.test.ts insert what they need",
  invites: "invite rows; the open-signup path does not read them",
  tg_links: "same — inserted by the test that routes through them",
  demo_sessions: "sandbox registry, swept by cron",
  demo_daily: "counters; demo-tally.test.ts drives them",
  shared_state: "counters; demo caps drive them",
  feedback: "written by a public endpoint",
  migrations: "the migration ledger itself",
  // §MCP-OAUTH: state of a flow in progress, not reference data. A pre-seeded client or a
  // pre-seeded code would be a grant nobody consented to sitting in every test database, and
  // oauth.test.ts drives all three tables through the endpoints that own them.
  oauth_clients: "registered by the flow; oauth.test.ts drives them",
  oauth_codes: "single-use codes, minted mid-flow",
  oauth_grants: "refresh grants, minted at token exchange",
};

function tablesIn(dir: string): string[] {
  const names = new Set<string>();
  for (const f of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(ROOT, dir, f), "utf8");
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/gi)) names.add(m[1]);
  }
  return [...names];
}

function rowCount(db: MemDb, table: string): number {
  try {
    const r = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return r.n;
  } catch {
    return -1;   // table absent from this database — reported separately below
  }
}

test("every finance table either has fixture rows or is named as deliberately empty", () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    seedRareTables(db);

    const empty: string[] = [];
    for (const t of tablesIn("migrations")) {
      if (t in EMPTY_OK) continue;
      const n = rowCount(db, t);
      if (n === 0) empty.push(t);
    }
    assert.deepEqual(empty, [],
      "These tables have no fixture rows, so every test that reads them passes vacuously.\n" +
      "Seed them in `fixture.ts`, or add them to EMPTY_OK with a reason:\n  " + empty.join("\n  "));
  } finally { restore(); }
});

test("every directory table either has rows or is named", () => {
  const db = migratedDirectoryDb();
  const empty = tablesIn("migrations-directory")
    .filter((t) => !(t in DIR_EMPTY_OK) && rowCount(db, t) === 0);
  assert.deepEqual(empty, [], "Unseeded directory tables: " + empty.join(", "));
});

test("the EMPTY_OK lists name only tables that EXIST", () => {
  // An entry for a table that was renamed or dropped is a claim about nothing — and it would keep
  // a real, newly-added table of the same name permanently exempt if one ever appeared.
  const finance = new Set(tablesIn("migrations"));
  const dir = new Set(tablesIn("migrations-directory"));
  const stale = [
    ...Object.keys(EMPTY_OK).filter((t) => !finance.has(t) && !t.startsWith("_") && t !== "migrations"),
    ...Object.keys(DIR_EMPTY_OK).filter((t) => !dir.has(t) && t !== "migrations"),
  ];
  assert.deepEqual(stale, [], "EMPTY_OK names tables that no longer exist: " + stale.join(", "));
});
