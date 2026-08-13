/**
 * PrivatBank AutoClient: the mapping, and only the mapping.
 *
 * ⚠️ Stated plainly because it changes how much these tests are worth: **this integration has
 * never spoken to the real service** — the owner has no ФОП account to link, and AutoClient has no
 * public sandbox. So what is pinned here is everything that can be established without one: that
 * the shape described in the spec is read correctly, and that the four decisions which fail
 * SILENTLY are made the way BANKS.md §2.1 says.
 *
 * Those four, in order of how quietly they would go wrong:
 *   1. the sign is in `TRANTYPE`, not in `SUM` — reading the amount alone turns every withdrawal
 *      into income, and the report still adds up;
 *   2. `PR_PR` `t`/`n` is money that did NOT move;
 *   3. the timestamp is a Kyiv wall clock;
 *   4. ids are namespaced, or a bank reference could collide with a monobank one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { privatToAccount, privatToCanonical, type PrivatTransaction } from "../lib/bank/privat.ts";
import { parseCredential } from "../lib/bank/providers/privat.ts";
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

  await t.test("a date-only row still lands, on its own day", () => {
    const row = privatToCanonical(tx({ DATE_TIME_DAT_OD_TIM_P: undefined, DAT_OD: "01.05.2026" }), "pb_UA1", UAH_ACCOUNT)!;
    assert.equal(localYmd(row.time), "2026-05-01");
  });

  await t.test("reversed and rejected rows are NOT money", () => {
    // `t` (reversed) and `n` (rejected) describe money that did not move; storing them would
    // invent spending. monobank has no equivalent state, which is why this is easy to forget.
    assert.equal(privatToCanonical(tx({ PR_PR: "t" }), "pb_UA1", UAH_ACCOUNT), null);
    assert.equal(privatToCanonical(tx({ PR_PR: "n" }), "pb_UA1", UAH_ACCOUNT), null);
  });

  await t.test("a processing row is stored as a HOLD, like monobank's", () => {
    assert.equal(privatToCanonical(tx({ PR_PR: "p" }), "pb_UA1", UAH_ACCOUNT)!.hold, true);
    assert.equal(privatToCanonical(tx({ PR_PR: "r" }), "pb_UA1", UAH_ACCOUNT)!.hold, false);
  });

  await t.test("the id is namespaced and built from REF + REFN", () => {
    // `transactions.id` is ONE key space across every bank.
    assert.equal(privatToCanonical(tx(), "pb_UA1", UAH_ACCOUNT)!.id, "pb_ABC123_1");
    // Same reference, different sequence number = a different transaction.
    assert.notEqual(
      privatToCanonical(tx({ REFN: "2" }), "pb_UA1", UAH_ACCOUNT)!.id,
      privatToCanonical(tx(), "pb_UA1", UAH_ACCOUNT)!.id,
    );
    // No reference at all: fall back to the row's own id rather than inventing one, because an
    // id we made up cannot de-duplicate and the row would multiply on every re-fetch.
    assert.equal(
      privatToCanonical(tx({ REF: undefined, REFN: undefined, ID: "T-9" }), "pb_UA1", UAH_ACCOUNT)!.id,
      "pb_T-9",
    );
    assert.equal(privatToCanonical(tx({ REF: undefined, REFN: undefined, ID: undefined }), "pb_UA1", UAH_ACCOUNT), null);
  });

  await t.test("the counterparty is the merchant, the purpose is the comment", () => {
    // Both are matched by text rules (§RULES-UI joins description + comment), but only the
    // description becomes the visible name — and "ТОВ Постачальник" reads as a merchant while a
    // sentence about invoice №7 does not.
    const row = privatToCanonical(tx(), "pb_UA1", UAH_ACCOUNT)!;
    assert.equal(row.description, "ТОВ Постачальник");
    assert.equal(row.comment, "Оплата за послуги згідно рахунку №7");
    // AutoClient carries no MCC at all, which is what costs this bank its deterministic
    // categorisation (BANKS.md §2.2) — asserted so nobody "fixes" it with a guess.
    assert.equal(row.mcc, null);
    assert.equal(row.balance_after, null);
  });

  await t.test("the currency comes from letters, falling back to the account", () => {
    assert.equal(privatToCanonical(tx({ CCY: "USD" }), "pb_UA1", UAH_ACCOUNT)!.currency_code, 840);
    assert.equal(privatToCanonical(tx({ CCY: undefined }), "pb_UA1", UAH_ACCOUNT)!.currency_code, 980);
  });

  await t.test("an unreadable amount is dropped, not stored as zero", () => {
    assert.equal(privatToCanonical(tx({ SUM: "" }), "pb_UA1", UAH_ACCOUNT), null);
  });
});

test("privat: a balance row becomes an account", async (t) => {
  await t.test("the readable case", () => {
    const acc = privatToAccount({ acc: "UA123456", currency: "UAH", balanceOut: "10 000,00", nameACC: "Рахунок ФОП" })!;
    assert.deepEqual({ ...acc }, {
      id: "pb_UA123456", type: "current", title: "Рахунок ФОП",
      currency_code: 980, balance: 1_000_000, credit_limit: 0, iban: "UA123456",
    });
  });

  await t.test("no readable currency: no account", () => {
    // An account whose currency we guessed would price everything it holds at the wrong rate,
    // and the mistake would be invisible — every number would simply be 40× off.
    assert.equal(privatToAccount({ acc: "UA1", currency: "XYZ", balanceOut: "1,00" }), null);
    assert.equal(privatToAccount({ currency: "UAH", balanceOut: "1,00" }), null);
  });
});

test("privat: the credential carries two values in one opaque string", async (t) => {
  await t.test("JSON with both", () => {
    assert.deepEqual(parseCredential('{"id":"12345","token":"abc"}'), { id: "12345", token: "abc" });
  });

  await t.test("a bare token is accepted", () => {
    // A single-client integration genuinely needs only the token. Rejecting it would mean an
    // error message about a format the user was never shown.
    assert.deepEqual(parseCredential("  abc  "), { token: "abc" });
  });

  await t.test("empty is refused", () => {
    assert.throws(() => parseCredential("   "), /empty credential/);
  });
});
