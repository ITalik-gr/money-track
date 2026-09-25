/**
 * The paced statement backfill and polling, driven by a FAKE bank: window, pacing and rate-limit
 * shape belong to the provider (§BANK-FETCH / §BANK-POLL). A stalled ingest fails silently.
 */
import test from "node:test";
import assert from "node:assert/strict";
// Through the wiring module, so registering the fake also registers the real ones — the loop must
// keep working in a registry that holds more than one bank.
import "../lib/bank/providers/index.ts";
import { CredentialRefused, registerProvider, type CanonicalTx } from "../lib/bank/providers/provider.ts";
import { startBackfill, stepBackfill, CURSOR_KEY } from "../lib/bank/backfill.ts";
import { nextPollAt, pollOnce } from "../lib/bank/poll.ts";
import { getState } from "../lib/finance/repo.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { Env } from "../env.ts";

const DAY = 24 * 60 * 60;
const WINDOW = 7 * DAY;   // deliberately NOT monobank's 31 days
const GAP_MS = 5_000;     // deliberately NOT monobank's 60 seconds

/** What the fake bank was asked, so the test can assert on the CALLS and not only on the rows. */
interface Call { account: string; from: number; to: number; currency: number }

class FakeRateLimit extends Error {}

function installFakeBank(opts: { rows?: (call: Call) => CanonicalTx[]; failWith?: () => never; secret?: "mono_token" } = {}) {
  const calls: Call[] = [];
  registerProvider({
    id: "fake",
    label: "Fake Bank",
    mode: "poll",
    secret: opts.secret,
    statement: {
      pacing: { maxWindowSec: WINDOW, minGapMs: GAP_MS },
      async fetch(_credential, account, from, to, currency) {
        calls.push({ account, from, to, currency });
        if (opts.failWith) opts.failWith();
        return opts.rows?.({ account, from, to, currency }) ?? [];
      },
      isRateLimit: (e) => e instanceof FakeRateLimit,
    },
  });
  return calls;
}

/** A database whose accounts belong to the fake bank, plus a credential for it. */
function fakeBankEnv(db: MemDb, opts: { credential?: boolean } = {}): Env {
  db.raw.prepare("UPDATE accounts SET provider = 'fake' WHERE id = 'acc-uah'").run();
  db.raw.prepare("UPDATE accounts SET is_active = 0 WHERE id <> 'acc-uah'").run();
  return {
    ...testEnv(db),
    BANK_CREDENTIALS: opts.credential === false ? {} : { fake: "fake-token" },
  } as unknown as Env;
}

function row(over: Partial<CanonicalTx> = {}): CanonicalTx {
  return {
    id: "fake-1",
    account_id: "acc-uah",
    time: 1_778_000_000,
    amount: -12_345,
    currency_code: 980,
    description: "Fake merchant",
    ...over,
  };
}

test("backfill: the window and the pacing come from the BANK", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    await t.test("jobs are cut to the provider's own window, not a shared constant", async () => {
      installFakeBank();
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db);

      const cursor = await startBackfill(env);
      // 90 days of history in 7-day windows for one account.
      assert.equal(cursor.total, Math.ceil(90 / 7));
      assert.equal(cursor.jobs[0]!.provider, "fake");
      const job = cursor.jobs[0]!;
      assert.equal(job.to - job.from, WINDOW);
    });

    await t.test("one step fetches one window and writes through the canonical writer", async () => {
      const calls = installFakeBank({ rows: () => [row()] });
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db);
      const cursor = await startBackfill(env);

      const res = await stepBackfill(env);
      assert.equal(res?.progress, 1);
      assert.equal(res?.done, false);
      assert.equal(calls.length, 1);
      // The account's currency is handed to the provider so IT can decide `original_*` without
      // reaching for the database (§R2-CUR1).
      assert.equal(calls[0]!.currency, 980);

      // Spread into a plain object: better-sqlite3 rows have a null prototype, which a strict
      // deep-equal counts as a difference even when every field matches.
      const stored = { ...(db.raw
        .prepare("SELECT id, source, amount, currency_code, merchant FROM transactions WHERE id = 'fake-1'")
        .get() as Record<string, unknown>) };
      // `source` is the provider's own id, so a row can always be traced back to what fetched it.
      assert.deepEqual(stored, {
        id: "fake-1", source: "fake", amount: -12_345, currency_code: 980, merchant: "Fake merchant",
      });
      assert.equal(cursor.total > 1, true);
    });

    await t.test("a rate limit is a PAUSE, not a lost window", async () => {
      // The cursor must not advance: advancing on a refused request would skip that window's
      // transactions for good, and nothing would ever notice they are missing.
      const calls = installFakeBank({ failWith: () => { throw new FakeRateLimit(); } });
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db);
      await startBackfill(env);

      const res = await stepBackfill(env);
      assert.equal(res?.retry, true);
      assert.equal(res?.progress, 0);
      assert.equal(calls.length, 1);

      const cursor = JSON.parse((await getState(env.DB, CURSOR_KEY))!) as { idx: number };
      assert.equal(cursor.idx, 0);
    });

    await t.test("any OTHER error is thrown, not swallowed as pacing", async () => {
      // A provider that reports every failure as a rate limit would spin forever; one that
      // reported none would lose windows. So the distinction has to be the provider's own.
      installFakeBank({ failWith: () => { throw new Error("bank is down"); } });
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db);
      await startBackfill(env);
      await assert.rejects(() => stepBackfill(env), /bank is down/);
    });

  } finally {
    restore();
  }
});

/**
 * The poll loop (§BANK-POLL). A bank that does not push is only as fresh as its last poll, and
 * every failure mode here is silent: a stalled poll produces no error, just history that stops.
 */
test("poll: a bank that does not push is asked, one account per pass", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    await t.test("a webhook bank is NEVER polled", async () => {
      // monobank can be asked for a statement — that is how the backfill works — but polling it
      // would spend its one-request-a-minute budget re-fetching what the webhook already sent.
      installFakeBank();
      const db = migratedDb();
      seed(db);
      const env = { ...testEnv(db), BANK_CREDENTIALS: { mono: "t" } } as unknown as Env;
      assert.equal(await nextPollAt(env), null);
      assert.equal(await pollOnce(env), null);
    });

    await t.test("the next window OVERLAPS the last one", async () => {
      // A bank posts an operation minutes to hours after it happened. Asking strictly "since the
      // last poll" loses everything that landed late, and nothing about the result looks wrong.
      const calls = installFakeBank({ rows: () => [] });
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db);
      await pollOnce(env);
      // Force the account overdue by rewinding its stamp by an hour more than the interval.
      db.raw.prepare("UPDATE app_state SET value = ? WHERE key = 'poll_at_acc-uah'")
        .run(String(Date.now() - 31 * 60_000));
      await pollOnce(env);
      assert.equal(calls.length, 2);
      assert.equal(calls[1]!.from < Date.now() / 1000 - 31 * 60, true);
    });

    await t.test("a hard failure marks the account polled, so it cannot starve the others", async () => {
      // Otherwise a permanently broken credential stays "most overdue" forever and every pass is
      // spent re-failing on it. The failure is recorded where a person can see it instead.
      installFakeBank({ failWith: () => { throw new Error("token expired"); } });
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db);

      assert.equal(await pollOnce(env), null);
      const conn = db.raw.prepare("SELECT status, last_error, last_sync_at FROM bank_connections").get() as
        { status: string; last_error: string; last_sync_at: number | null };
      assert.equal(conn.status, "error");
      assert.match(conn.last_error, /token expired/);
      // Never synced successfully, so there is no last-success time to show — and inventing one
      // would claim it worked.
      assert.equal(conn.last_sync_at, null);
      // Not due again immediately.
      assert.equal(await pollOnce(env), null);
    });

  } finally {
    restore();
  }
});

test("§BANK-CRED: a token the bank refuses after it was saved stops reading as verified", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = migratedDb();
    seed(db);
    const env = fakeBankEnv(db);
    // Saved and verified at save time — what `putSecret` writes for a token that worked then.
    db.raw.prepare("INSERT INTO user_secrets (name, ciphertext, iv, updated_at, last_ok_at) VALUES ('mono_token', 'x', 'y', 1, 1)").run();
    const status = () => db.raw.prepare("SELECT last_ok_at FROM user_secrets WHERE name = 'mono_token'").get() as { last_ok_at: number | null };

    // An outage says nothing about the token.
    installFakeBank({ secret: "mono_token", failWith: () => { throw new Error("bank is down"); } });
    await startBackfill(env);
    await assert.rejects(stepBackfill(env));
    assert.equal(status().last_ok_at, 1);

    // A 401 does.
    installFakeBank({ secret: "mono_token", failWith: () => { throw new CredentialRefused("fake -> 401"); } });
    await assert.rejects(stepBackfill(env), CredentialRefused);
    assert.equal(status().last_ok_at, null, "a refused token must not stay «verified»");

    // …and the first success after one marks it verified again.
    installFakeBank({ secret: "mono_token" });
    await stepBackfill(env);
    assert.ok(status().last_ok_at! > 1);
  } finally {
    restore();
  }
});
