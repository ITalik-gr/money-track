/**
 * PrivatBank AutoClient mapping only — this integration has never touched the live API. Pinned are the
 * decisions that fail silently: the sign from TRANTYPE, Kyiv time, reversed rows, holds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { privatToCanonical, type PrivatTransaction } from "../lib/bank/privat.ts";
import { localYmd, localParts } from "../lib/finance/stats.ts";

const UAH_ACCOUNT = 980;

function tx(over: Partial<PrivatTransaction> = {}): PrivatTransaction {
  return {
    REF: "ABC123",
    REFN: "1",
    SUM: "1 234,56",
    CCY: "UAH",
    TRANTYPE: "D",
    PR_PR: "r",
    OSND: "Оплата за послуги згідно рахунку №7",
    AUT_CNTR_NAM: "ТОВ Постачальник",
    DATE_TIME_DAT_OD_TIM_P: "01.05.2026 21:30:00",
    ...over,
  };
}

test("privat: a transaction becomes a canonical row", async (t) => {
  await t.test("the SIGN comes from TRANTYPE, not from the amount", () => {
    assert.equal(privatToCanonical(tx({ TRANTYPE: "D" }), "pb_UA1", UAH_ACCOUNT)!.amount, -123_456);
    assert.equal(privatToCanonical(tx({ TRANTYPE: "C" }), "pb_UA1", UAH_ACCOUNT)!.amount, 123_456);
    // A magnitude that already carries a minus must not double-negate into income.
    assert.equal(privatToCanonical(tx({ TRANTYPE: "D", SUM: "-1 234,56" }), "pb_UA1", UAH_ACCOUNT)!.amount, -123_456);
  });

  await t.test("the timestamp is read as KYIV time", () => {
    // 21:30 local. Read as UTC it would land on 2 May, i.e. the wrong day, week and possibly month.
    const row = privatToCanonical(tx(), "pb_UA1", UAH_ACCOUNT)!;
    assert.equal(localYmd(row.time), "2026-05-01");
    assert.equal(localParts(row.time).hh, 21);
  });

  await t.test("reversed and rejected rows are NOT money", () => {
    // `t` (reversed) and `n` (rejected) describe money that did not move; storing them would
    // invent spending. monobank has no equivalent state, which is why this is easy to forget.
    assert.equal(privatToCanonical(tx({ PR_PR: "t" }), "pb_UA1", UAH_ACCOUNT), null);
    assert.equal(privatToCanonical(tx({ PR_PR: "n" }), "pb_UA1", UAH_ACCOUNT), null);
  });

  await t.test("an unreadable amount is dropped, not stored as zero", () => {
    assert.equal(privatToCanonical(tx({ SUM: "" }), "pb_UA1", UAH_ACCOUNT), null);
  });
});
