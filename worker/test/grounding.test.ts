/**
 * The deterministic guard against invented figures.
 *
 * It exists because the prompt already forbade computing new numbers and that WAS NOT ENOUGH: on
 * real data the model put two different subscription totals in one notification. `CLAUDE.md` states
 * the general rule — if a number from the AI reaches the UI, a check stands beside it — and until
 * 2026-08-21 the check guarded the feed alone, while `structured.facts[].amount` went straight onto
 * the Advisor card and into the Telegram digest.
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

test("small numbers pass unchecked, because they are not sums", () => {
  // Counts, percentages and dates would otherwise have to appear in the payload verbatim, and a
  // guard that rejects «за 7 днів» teaches everyone to remove it.
  const k = known({ total: 99999 });
  assert.equal(numbersAreGrounded("за 7 днів у 3 категоріях", k), true);
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

test("collectNumbers reaches into nested payloads, and stops before it runs away", () => {
  const k = known({ a: [{ b: { c: 777 } }], s: "1234.5" });
  assert.ok(k.has(777));
  assert.ok(k.has(1234.5), "numeric strings count — the payload serialises some figures as text");
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

test("a day of the month is checked too — 20 and 21 are different days", () => {
  const a = days(20, 6);
  assert.equal(timeClaimsAreGrounded("платіж 20-го числа", a, months(7)), true);
  assert.equal(timeClaimsAreGrounded("rent on the 20th", a, months(7)), true);
  assert.equal(timeClaimsAreGrounded("rent on the 21st", a, months(7)), false);
  assert.equal(timeClaimsAreGrounded("платіж 21-го числа", a, months(7)), false);
});

test("an empty anchor set rejects every date, because we told it no schedule", () => {
  // The exact situation that produced the bug: the payload named no schedule for rent at all.
  assert.equal(timeClaimsAreGrounded("через 25 днів", days(), months(7)), false);
  assert.equal(timeClaimsAreGrounded("витрати зросли", days(), months(7)), true);
});

test("a month the payload does not name is a projection, not a fact", () => {
  // «Your real money ends before October» — computed by eye out of a runway figure.
  assert.equal(timeClaimsAreGrounded("гроші закінчаться до жовтня", days(), months(6, 7, 8)), false);
  assert.equal(timeClaimsAreGrounded("money ends before October", days(), months(6, 7, 8)), false);
  assert.equal(timeClaimsAreGrounded("у серпні витрачено більше", days(), months(6, 7, 8)), true);
});

// ---- one card, one language ------------------------------------------------------------------
test("an English headline on a Ukrainian feed is rejected, and brand names are not", () => {
  assert.equal(scriptMatchesLocale("Utilities locked at 1660 per month", "uk"), false);
  assert.equal(scriptMatchesLocale("Комуналка тримається на 1 660 ₴/міс", "uk"), true);
  // A Ukrainian sentence naming Claude and Spotify is correct — a word list could never say so.
  assert.equal(scriptMatchesLocale("Підписки Claude і Spotify зʼїдають 1 292 ₴", "uk"), true);
  assert.equal(scriptMatchesLocale("Subscriptions now equal the rent burden", "en"), true);
  assert.equal(scriptMatchesLocale("Комуналка зросла на 53%", "en"), false);
  // Too short to have a language at all — rejecting it would be a guess of our own.
  assert.equal(scriptMatchesLocale("PS Plus 350 ₴", "uk"), true);
});
