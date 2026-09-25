/**
 * §ENV-STATE — «exactly spent» is not «over»; the grid and the dashboard read the same verdict.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { envelopeState } from "../../shared/envelope.ts";

const at = (ratio: number, amount = 10_000_00) => envelopeState({ amount, spent: Math.round(amount * ratio), ratio });

test("§ENV-STATE: 99% is warn, 100% is full, 101% is over", () => {
  assert.equal(at(0.99), "warn");
  assert.equal(at(1.0), "full");
  assert.equal(at(1.01), "over");
});

test("§ENV-STATE: the boundary is the printed percentage", () => {
  assert.equal(at(1.004), "full"); // printed «100%» — never called over
  assert.equal(at(1.006), "over"); // printed «101%»
  assert.equal(at(0.5), "ok");
  assert.equal(at(0.8), "warn");
});

test("§ENV-STATE: a zero envelope is binary", () => {
  assert.equal(envelopeState({ amount: 0, spent: 0, ratio: 0 }), "ok");
  assert.equal(envelopeState({ amount: 0, spent: 1, ratio: 1 }), "over");
});
