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
      const listed = (await planningRepo.merchantMatches(as(m), "Netflix", since))
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
