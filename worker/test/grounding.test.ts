/**
 * The deterministic guard against invented figures and dates (`numbersAreGrounded`,
 * `timeClaimsAreGrounded`) — the prompt forbidding it was not enough.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  collectNumbers, numbersAreGrounded, groundFacts, timeClaimsAreGrounded, scriptMatchesLocale,
} from "../lib/ai/grounding.ts";

const known = (payload: unknown) => { const s = new Set<number>(); collectNumbers(payload, s); return s; };

test("a figure present in the payload passes; an invented one does not", () => {
  const k = known({ subscriptions_uah: 3400, groceries_uah: 12050 });
  assert.equal(numbersAreGrounded("підписки 3 400 ₴", k), true);
  // The bug verbatim: a second, different total for the same thing.
  assert.equal(numbersAreGrounded("підписки 5 900 ₴", k), false);
});

test("thousands separators are read as one number, not as two", () => {
  // «3 354» is one figure. Splitting on the space would make every grouped number ungrounded,
  // and the guard would reject everything — which is how a safeguard becomes a switch nobody
  // leaves on.
  const k = known({ total: 3354 });
  assert.equal(numbersAreGrounded("витрачено 3 354", k), true);
  assert.equal(numbersAreGrounded("витрачено 3 354", k), true);
});

test("a 1% tolerance survives rounding, and nothing wider does", () => {
  const k = known({ spent: 10000 });
  assert.equal(numbersAreGrounded("10 050", k), true, "rounding of the same figure");
  assert.equal(numbersAreGrounded("11 000", k), false, "a different figure");
});

test("groundFacts drops an invented amount rather than blanking it", () => {
  const payload = { by_category: [{ name: "Продукти", uah: 4200 }] };
  const facts = [
    { label: "Продукти", amount: 4200 },
    { label: "Підписки", amount: 9999 },   // never in the payload
    { label: "Без суми", amount: null },   // prose only — nothing to check
  ];
  const out = groundFacts(facts, payload);
  assert.deepEqual(out.map((f) => f.label), ["Продукти", "Без суми"]);
  // Dropped, not blanked: «Підписки — » on a card reads as a rendering bug, not as a withheld
  // figure, and a fact whose whole content was the number has nothing left without it.
  assert.ok(!out.some((f) => f.label === "Підписки"));
});

// ---- the CALENDAR half of the guard (2026-08-27) ---------------------------------------------
// Shipped bug, verbatim: «Rent due in 11 days, cushion covers only 0.8 months total» — for a rent
// the user pays on the 20th, which is not a `planned_payment` and therefore appears in no
// `upcoming_charges` row. Every figure in that sentence is under 100, so the money guard above saw
// nothing at all.
const days = (...d: number[]) => new Set(d);
const months = (...m: number[]) => new Set(m);

test("a day count the payload never stated is rejected", () => {
  const a = days(6, 9, 10, 20, 24, 29, 90, 30, 7);
  assert.equal(timeClaimsAreGrounded("Оренда через 11 днів", a, months(7, 8)), false);
  assert.equal(timeClaimsAreGrounded("Rent due in 11 days", a, months(7, 8)), false);
  assert.equal(timeClaimsAreGrounded("EasyPay спишеться через 6 днів", a, months(7, 8)), true);
  assert.equal(timeClaimsAreGrounded("за 90 днів у 3 категоріях", a, months(7, 8)), true);
});

test("a month the payload does not name is a projection, not a fact", () => {
  // «Your real money ends before October» — computed by eye out of a runway figure.
  assert.equal(timeClaimsAreGrounded("гроші закінчаться до жовтня", days(), months(6, 7, 8)), false);
  assert.equal(timeClaimsAreGrounded("money ends before October", days(), months(6, 7, 8)), false);
  assert.equal(timeClaimsAreGrounded("у серпні витрачено більше", days(), months(6, 7, 8)), true);
});

// ---- the PAIRED half (2026-10-27) ------------------------------------------------------------
// Shipped on 2026-10-27, verbatim: «Через 4 дні — оплата квартири … Квартиру треба платити
// 20 листопада 12500 ₴». 4 was `days_left_in_month`, the rent is no upcoming charge, and
// «20 листопада» matched neither day regex — every number was "stated", the sentence was false.
// The anchors below are that day's payload.
const oct27 = {
  days: days(6, 8, 9, 19, 23, 28, 30, 2, 4, 15, 24, 26, 27, 90, 7, 1),
  months: months(9, 10, 4, 5, 6, 7, 8),
  paired: {
    dates: new Set(["10-27", "11-02", "11-04", "11-06", "11-15", "11-19", "11-24", "11-26"]),
    countdowns: new Set([6, 8, 9, 19, 23, 28, 30, 15, 1, 7]),
    monthEnd: 4,
  },
};
const t27 = (s: string) => timeClaimsAreGrounded(s, oct27.days, oct27.months, oct27.paired);

test("a stated number used as the distance to something else is rejected", () => {
  assert.equal(t27("Через 4 дні — оплата квартири, а грошей немає"), false);
  assert.equal(t27("До кінця місяця 4 дні, а витрати вже вищі за дохід"), true);
  assert.equal(t27("EasyPay спишеться через 6 днів"), true);
  assert.equal(t27("Rent is due in 4 days"), false);
});

test("a named date must be a date the payload states, day and month together", () => {
  assert.equal(t27("Квартиру треба платити 20 листопада 12500 ₴"), false);
  assert.equal(t27("Claude спишеться 19 листопада"), true);
  // 19 and November are each stated — but not as one date.
  assert.equal(t27("Claude спишеться 19 грудня"), false);
  assert.equal(t27("Spotify renews on November 15"), true);
  assert.equal(t27("Rent is due November 20"), false);
});

test("one word in two scripts is a decoding slip, not a brand", () => {
  assert.equal(scriptMatchesLocale("Роzetka витягла 6696 ₴ на підготовку до зими", "uk"), false);
  assert.equal(scriptMatchesLocale("Rozetka витягла 6696 ₴ на підготовку до зими", "uk"), true);
});
