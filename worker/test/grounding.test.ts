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
import { collectNumbers, numbersAreGrounded, groundFacts } from "../lib/ai/grounding.ts";

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
