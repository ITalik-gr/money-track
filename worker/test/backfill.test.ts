/**
 * The paced statement backfill, driven by a FAKE bank.
 *
 * Why a fake and not monobank: the point of the rewrite (BANKS.md §5, step 3) is that the window
 * length, the request gap and the shape of "you are going too fast" belong to the provider rather
 * than to the loop. A test that used monobank would pass just as well against the old code, which
 * had those three constants written into the loop itself — so it would be testing nothing.
 *
 * This is also the ingest path, which fails SILENTLY: a stalled backfill produces no error and no
 * empty screen, just history that never arrives. There were no tests here at all before.
 */
import test from "node:test";
import assert from "node:assert/strict";
// Through the wiring module, so registering the fake also registers the real ones — the loop must
// keep working in a registry that holds more than one bank.
import "../lib/bank/providers/index.ts";
import { registerProvider, type CanonicalTx } from "../lib/bank/providers/provider.ts";
import { backfillPending, nextStepGapMs, startBackfill, stepBackfill, CURSOR_KEY } from "../lib/bank/backfill.ts";
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

function installFakeBank(opts: { rows?: (call: Call) => CanonicalTx[]; failWith?: () => never } = {}) {
  const calls: Call[] = [];
  registerProvider({
    id: "fake",
    label: "Fake Bank",
    mode: "poll",
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

    await t.test("the gap asked of the pacers is the provider's", async () => {
      // Both pacers — the object's alarm and the client's interval — read this. A hardcoded 60s
      // would break a bank that allows more, and quietly break one that allows less.
      installFakeBank();
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db);
      await startBackfill(env);
      assert.equal(await nextStepGapMs(env), GAP_MS);
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

    await t.test("no credential: the account never enters the cursor", async () => {
      // A job that can never run would sit there pretending to be progress, and the alarm would
      // keep waking up for it.
      installFakeBank();
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db, { credential: false });
      const cursor = await startBackfill(env);
      assert.equal(cursor.total, 0);
      assert.equal(await backfillPending(env.DB), false);
    });

    await t.test("a credential removed MID-run skips the job instead of stalling", async () => {
      // The alarm re-arms while the cursor has work left, so a job that cannot run and cannot
      // advance is an alarm that never stops — and a paid one.
      installFakeBank();
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db);
      await startBackfill(env);

      const withoutCredential = { ...env, BANK_CREDENTIALS: {} } as Env;
      const res = await stepBackfill(withoutCredential);
      assert.equal(res?.progress, 1);
      assert.equal(res?.retry, undefined);
    });

    await t.test("a manual account is never fetched", async () => {
      installFakeBank();
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db);
      db.raw.prepare("UPDATE accounts SET is_manual = 1 WHERE id = 'acc-uah'").run();
      const cursor = await startBackfill(env);
      assert.equal(cursor.total, 0);
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

    await t.test("a poll bank with no credential is not a deadline", async () => {
      installFakeBank();
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db, { credential: false });
      assert.equal(await nextPollAt(env), null);
    });

    await t.test("the first poll fetches a window and stores the rows", async () => {
      const calls = installFakeBank({ rows: () => [row({ id: "poll-1" })] });
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db);

      const res = await pollOnce(env);
      assert.deepEqual(res, { account: "acc-uah", rows: 1 });
      assert.equal(calls.length, 1);
      const stored = db.raw.prepare("SELECT source FROM transactions WHERE id = 'poll-1'").get() as { source: string };
      assert.equal(stored.source, "fake");
    });

    await t.test("a second pass right away does nothing — the account is not due", async () => {
      const calls = installFakeBank({ rows: () => [] });
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db);
      await pollOnce(env);
      assert.equal(await pollOnce(env), null);
      assert.equal(calls.length, 1);
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

    await t.test("a rate limit leaves the account DUE", async () => {
      // The opposite of a hard failure: nothing is wrong with the credential, we were simply too
      // early — so the window must not be consumed.
      installFakeBank({ failWith: () => { throw new FakeRateLimit(); } });
      const db = migratedDb();
      seed(db);
      const env = fakeBankEnv(db);
      assert.equal(await pollOnce(env), null);
      const stamp = db.raw.prepare("SELECT value FROM app_state WHERE key = 'poll_at_acc-uah'").get();
      assert.equal(stamp, undefined);
    });
  } finally {
    restore();
  }
});
