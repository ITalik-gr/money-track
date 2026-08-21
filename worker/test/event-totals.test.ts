/**
 * «Скільки коштувала подія» — one question, and until 2026-08-21 two answers.
 *
 * Five places computed it. Three (`repo/analytics.spendByEvent`, the advisor's context, the
 * insight's) went through the canon; the two that feed the EVENTS PAGE summed `t.amount` raw. The
 * page therefore disagreed with Statistics and with what the AI was told, about the same trip.
 *
 * The whole test is the cross-check: build an event containing the two things that distinguish
 * the formulas, then assert the page's figure equals the canon's. A test that merely asserted a
 * number would have passed against the old code too — the fixture has no reimbursed or
 * transferred rows, which is exactly why 621 tests stayed green while the bug was live.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as eventsRepo from "../repo/events.ts";
import * as analyticsRepo from "../repo/analytics.ts";
import { migratedDb, freezeTime, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";

const NOW = Math.floor(Date.parse(FROZEN_NOW_ISO) / 1000);
const MULT = "1";
/** The harness DB satisfies the slice of D1 the repo uses; the cast is the harness convention. */
const as = (m: MemDb) => m as unknown as never;

/** An event holding: a plain expense, a partly reimbursed one, and an internal transfer. */
function seedTrip(m: MemDb): void {
  const run = (sql: string, ...a: unknown[]) => m.raw.prepare(sql).run(...(a as never[]));
  run(`INSERT INTO event_groups (id, name, kind, is_active, created_at) VALUES (77, 'Карпати', 'trip', 1, ?)`, NOW - 20 * 86400);
  const tx = (id: string, amount: number, extra = "") =>
    run(`INSERT INTO transactions (id, account_id, source, time, amount, currency_code, event_id, is_transfer, reimbursed, created_at)
         VALUES ('${id}', 'acc-uah', 'manual', ?, ?, 980, 77, ${extra || "0, 0"}, 0)`, NOW - 10 * 86400, amount);

  tx("trip-plain", -300000);                    // 3 000 ₴ — all yours
  tx("trip-shared", -600000, "0, 400000");      // 6 000 ₴, of which 4 000 came back
  tx("trip-move", -500000, "1, 0");             // moving money to the travel card
}

test("the events page and the canon report the SAME trip", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    seedTrip(m);

    await t.test("a reimbursed share is not counted as yours", async () => {
      const totals = await eventsRepo.totals(as(m), MULT, 77);
      // 3 000 + (6 000 − 4 000) = 5 000. The old formula said 9 000: the full shared bill, plus
      // the transfer below.
      assert.equal(totals?.spent, 500000);
    });

    await t.test("an internal transfer is neither spending nor income", async () => {
      const totals = await eventsRepo.totals(as(m), MULT, 77);
      assert.equal(totals?.income, 0, "moving money to a travel card is not income to the trip");
    });

    await t.test("the list agrees with the detail, and both agree with Statistics", async () => {
      const list = (await eventsRepo.listWithTotals(as(m), MULT)).find((e) => e.id === 77)!;
      const detail = await eventsRepo.totals(as(m), MULT, 77);
      const canon = (await analyticsRepo.spendByEvent(
        as(m), { mult: MULT, curFilter: "" }, { from: NOW - 30 * 86400, to: NOW },
      )).find((e) => e.event_id === 77)!;

      assert.equal(list.spent, detail?.spent, "list vs detail");
      assert.equal(list.spent, canon.spent, "page vs Statistics — the disagreement this closes");
      // And the count is of PURCHASES, not of joined rows.
      assert.equal(list.tx_count, 3);
    });
  } finally { restore(); }
});
