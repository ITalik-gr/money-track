/**
 * §BANK-PARSE — a date, an amount and a currency read from bank strings: a zone-less time is Kyiv,
 * one rounding in minor units, an unknown currency is null (never 980).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { currencyNumeric, parseAmountMinor, parseStatementDate } from "../lib/bank/normalize.ts";
import { localParts, localYmd } from "../lib/finance/stats.ts";

test("statement dates: a zone-less wall clock is KYIV time", async (t) => {
  await t.test("an evening operation stays on the day it happened", () => {
    // The bug this replaced: `Date.UTC` read 23:30 as UTC, stored the row three hours late and
    // filed it under 2 May — wrong day, sometimes wrong week and wrong month, with every total
    // still adding up. Summer here, so Kyiv is UTC+3.
    const ts = parseStatementDate("01.05.2026 23:30")!;
    assert.equal(localYmd(ts), "2026-05-01");
    const p = localParts(ts);
    assert.equal(`${p.hh}:${String(p.mm).padStart(2, "0")}`, "23:30");
  });

  await t.test("a date with no time is local midnight", () => {
    const ts = parseStatementDate("01.05.2026")!;
    assert.equal(localYmd(ts), "2026-05-01");
    const p = localParts(ts);
    assert.deepEqual([p.hh, p.mm, p.ss], [0, 0, 0]);
  });

});

test("amounts: one rounding, in minor units", async (t) => {
  await t.test("Ukrainian export forms", () => {
    // A non-breaking space as the thousands separator, a decimal comma, and the accounting
    // parenthesis for a negative — all three appear in real statements.
    assert.equal(parseAmountMinor("-1 234,56"), -123_456);
    assert.equal(parseAmountMinor("1 234,56"), 123_456);
    assert.equal(parseAmountMinor("(1 234,56)"), -123_456);
    assert.equal(parseAmountMinor("1234.56"), 123_456);
  });

  await t.test("the LAST separator is the decimal one", () => {
    assert.equal(parseAmountMinor("1.234,56"), 123_456);
    assert.equal(parseAmountMinor("1,234.56"), 123_456);
    // Three digits after the separator means it was a thousands separator after all.
    assert.equal(parseAmountMinor("1.234"), 123_400);
  });

  await t.test("empty and unreadable values are null, not zero", () => {
    // Zero is a real amount; "I could not read this" must not be storable as one.
    assert.equal(parseAmountMinor(""), null);
    assert.equal(parseAmountMinor("—"), null);
    assert.equal(parseAmountMinor("0,00"), 0);
  });
});

test("currency: letters become the numeric code we store", async (t) => {

  await t.test("an unknown code is null, NEVER a fallback to hryvnia", () => {
    // The whole reason this is a lookup: calling an unrecognised currency 980 would silently
    // multiply a balance by the exchange rate, and nothing would report an error.
    assert.equal(currencyNumeric("XYZ"), null);
    assert.equal(currencyNumeric(""), null);
    assert.equal(currencyNumeric(null), null);
  });
});
