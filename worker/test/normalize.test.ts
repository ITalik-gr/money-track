/**
 * The three things every bank feed makes us read from a string: a date, an amount, a currency.
 *
 * These are assertions rather than goldens on purpose. A golden of `1777582800` proves the number
 * did not change; it does not say what the number MEANS, and the whole class of bug here is a
 * value that is wrong while looking entirely reasonable. So each case states the meaning — "an
 * evening purchase belongs to the day it was made" — and checks it in those terms.
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

  await t.test("the same holds in winter, when the offset is different", () => {
    // Not a copy of the case above: the offset is +2 in January, so a parser that hardcoded one
    // shift instead of resolving it per moment would pass the first test and fail this one.
    const ts = parseStatementDate("15.01.2026 23:30")!;
    assert.equal(localYmd(ts), "2026-01-15");
    assert.equal(localParts(ts).hh, 23);
  });

  await t.test("a date with no time is local midnight", () => {
    const ts = parseStatementDate("01.05.2026")!;
    assert.equal(localYmd(ts), "2026-05-01");
    const p = localParts(ts);
    assert.deepEqual([p.hh, p.mm, p.ss], [0, 0, 0]);
  });

  await t.test("an explicit offset is honoured as written, not re-interpreted", () => {
    // The sender said what it meant. Treating this as a wall clock would move it by the local
    // offset — the same mistake, pointing the other way.
    assert.equal(parseStatementDate("2026-05-01T10:00:00Z"), Date.UTC(2026, 4, 1, 10) / 1000);
  });

  await t.test("ISO and dashed forms read the same as the dotted one", () => {
    const dotted = parseStatementDate("01.05.2026 09:15");
    assert.equal(parseStatementDate("2026-05-01 09:15"), dotted);
    assert.equal(parseStatementDate("01-05-2026 09:15"), dotted);
  });

  await t.test("unix seconds pass through, nonsense returns null", () => {
    assert.equal(parseStatementDate("1777582800"), 1_777_582_800);
    assert.equal(parseStatementDate("не дата"), null);
    assert.equal(parseStatementDate(""), null);
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
  await t.test("the codes a Ukrainian account actually meets", () => {
    assert.equal(currencyNumeric("UAH"), 980);
    assert.equal(currencyNumeric("usd"), 840);
    assert.equal(currencyNumeric(" EUR "), 978);
    assert.equal(currencyNumeric("PLN"), 985);
  });

  await t.test("a numeric code passes through, whether given as a number or a string", () => {
    // Feeds that already speak numeric (monobank) share this door with feeds that do not.
    assert.equal(currencyNumeric(980), 980);
    assert.equal(currencyNumeric("840"), 840);
  });

  await t.test("an unknown code is null, NEVER a fallback to hryvnia", () => {
    // The whole reason this is a lookup: calling an unrecognised currency 980 would silently
    // multiply a balance by the exchange rate, and nothing would report an error.
    assert.equal(currencyNumeric("XYZ"), null);
    assert.equal(currencyNumeric(""), null);
    assert.equal(currencyNumeric(null), null);
  });
});
