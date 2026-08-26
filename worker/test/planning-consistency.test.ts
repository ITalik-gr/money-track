/**
 * The search row and the plan created FROM that row must describe the same merchant.
 *
 * §F4 has two steps: type a description, pick a row, get a plan pre-filled with its typical
 * charge. Two queries answer "typical charge" — `merchantMatches` for the list and
 * `merchantProfile` for the row you clicked — and until 2026-08-21 they disagreed about holds:
 * the list excluded them, the profile did not. So the number you chose and the number you got
 * were computed over different sets of transactions.
 *
 * Following the lesson of the events audit: the test does not assert an amount. It builds data
 * where the two formulas MUST differ if they still disagree, and compares them to each other.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as planningRepo from "../repo/planning.ts";
import { migratedDb, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";

const NOW = Math.floor(Date.parse(FROZEN_NOW_ISO) / 1000);
const as = (m: MemDb) => m as unknown as never;

/** Two settled charges and one still on hold — the case the two queries used to split on. */
function seedMerchant(m: MemDb): void {
  const tx = (id: string, amount: number, hold: number, daysAgo: number) =>
    m.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, hold, is_transfer, created_at)
       VALUES (?, 'acc-uah', 'mono', ?, ?, 980, 'Netflix UA', ?, 0, 0)`,
    ).run(id, NOW - daysAgo * 86400, amount, hold);

  tx("nf-1", -30000, 0, 70);
  tx("nf-2", -30000, 0, 40);
  // The newest charge is still pending — and it is the one a person is most likely reacting to.
  tx("nf-3", -45000, 1, 2);
}

test("§F4: the list and the profile agree about a merchant", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    seedMerchant(m);
    const since = NOW - 180 * 86400;

    await t.test("the same average, whichever way you reach the merchant", async () => {
      const listed = (await planningRepo.merchantMatches(as(m), ["Netflix"], since))
        .find((r) => r.merchant === "Netflix UA")!;
      const profile = await planningRepo.merchantProfile(as(m), "Netflix UA", since);

      assert.ok(listed && profile, "both paths find the merchant");
      // With the old `hold = 0` on the list only, these were 300 and 350: you picked one number
      // and the form offered another.
      assert.equal(listed.avg_amount, profile!.avg_amount, "average charge");
      assert.equal(listed.n, profile!.n, "and the count it was averaged over");
    });

    await t.test("a pending charge is counted, as the canon says", async () => {
      const profile = await planningRepo.merchantProfile(as(m), "Netflix UA", since);
      assert.equal(profile!.n, 3, "three charges, one of them still on hold");
      // Not a preference: monobank sends only executed operations and overwrites the same id on
      // settlement, so excluding holds drops the freshest week for no gain (`stats.ts`).
    });
  } finally { restore(); }
});

/**
 * §SUB-FIND (2026-08-27) — the search reads everything the app knows about an operation.
 *
 * Reported verbatim: searching «твітер» found nothing, because the charge is stored as «X Corp.» —
 * while the owner had told the AI, on that transaction, that it IS his Twitter subscription, and
 * the model had written that down in `ai_note`. The answer was in the database and the query did
 * not look at it. The second half of the same report: «X підписка» returned OnTa**x**i and
 * E**x**pres, because a one-letter term is a `LIKE '%X%'`.
 */
test("§SUB-FIND: the search reads the AI's note, not just the merchant", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    const ins = (id: string, merchant: string, note: string | null, daysAgo: number) =>
      m.raw.prepare(
        `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant,
           ai_note, hold, is_transfer, created_at)
         VALUES (?, 'acc-uah', 'mono', ?, -11600, 980, ?, ?, 0, 0, 0)`,
      ).run(id, NOW - daysAgo * 86400, merchant, note);
    ins("x-1", "X Corp.", "X (твітер) підписка", 40);
    ins("x-2", "X Corp.", "X (твітер) підписка", 10);
    // The noise the one-letter term used to drag in — same letter, nothing to do with it.
    ins("taxi-1", "OnTaxi", null, 12);
    const since = NOW - 200 * 86400;

    await t.test("a Cyrillic word the AI wrote finds the Latin merchant", async () => {
      const rows = await planningRepo.merchantMatches(as(m), ["твітер"], since);
      assert.deepEqual(rows.map((r) => r.merchant), ["X Corp."]);
    });

    await t.test("capitalisation does not decide it — LIKE folds ASCII only", async () => {
      // «Твітер» typed with a capital never matched, and nothing said why.
      const rows = await planningRepo.merchantMatches(as(m), ["Твітер"], since);
      assert.deepEqual(rows.map((r) => r.merchant), ["X Corp."]);
    });

    await t.test("several aliases are OR-ed, so a rename does not lose the row", async () => {
      const rows = await planningRepo.merchantMatches(as(m), ["Twitter", "X Corp"], since);
      assert.deepEqual(rows.map((r) => r.merchant), ["X Corp."]);
    });

    await t.test("OnTaxi is not a Twitter subscription", async () => {
      const rows = await planningRepo.merchantMatches(as(m), ["твітер", "X Corp"], since);
      assert.ok(!rows.some((r) => r.merchant === "OnTaxi"));
    });
  } finally { restore(); }
});
