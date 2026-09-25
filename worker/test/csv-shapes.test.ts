/**
 * §CSV-DEBIT — a statement carries its amount in one signed column or in a Дебет/Кредит pair where
 * the sign is WHICH column is filled; the pair used to be silently misread.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { guessMapping, toCanonical, type ColumnMapping } from "../lib/bank/providers/csv.ts";

const conv = (rows: string[][], m: Partial<ColumnMapping>) =>
  toCanonical(rows, m as ColumnMapping, "acc", 980, true, "uk");

// ---- one signed column: unchanged ------------------------------------------------------------

test("§CSV-DEBIT: a single signed column is read exactly as before", async () => {
  const rows = [
    ["Дата", "Опис", "Сума", "MCC"],
    ["01.05.2026", "Сільпо", "-250,00", "5411"],
    ["02.05.2026", "Зарплата", "10000,00", "4829"],
  ];
  const m = guessMapping(rows[0]);
  assert.equal(m.amount, 2);
  assert.equal(m.credit, undefined, "one column is not a pair");

  const { txs } = await conv(rows, m);
  assert.deepEqual(txs.map((t) => t.amount), [-25000, 1000000]);
});

// ---- two columns -----------------------------------------------------------------------------

const LEDGER = [
  ["Дата", "Опис", "Дебет", "Кредит"],
  ["01.05.2026", "Сільпо", "250,00", ""],
  ["02.05.2026", "Зарплата", "", "10000,00"],
  ["03.05.2026", "Аптека", "100,00", ""],
];

test("§CSV-DEBIT: the SIGN comes from the column, not from the cell", async () => {
  const { txs, skipped } = await conv(LEDGER, guessMapping(LEDGER[0]));
  // All three rows survive. Before this, only the ones with a debit did — and as INCOME.
  assert.equal(skipped.length, 0, "an empty cell on one side is how a ledger says «other kind»");
  assert.deepEqual(txs.map((t) => t.amount), [-25000, 1000000, -10000]);
});

test("§CSV-DEBIT: a row empty on BOTH sides is skipped, not imported as zero", async () => {
  const rows = [LEDGER[0], ["01.05.2026", "Порожня", "", ""]];
  const { txs, skipped } = await conv(rows, guessMapping(rows[0]));
  assert.equal(txs.length, 0);
  assert.equal(skipped.length, 1);
});

test("§CSV-DEBIT: a lone CREDIT column is refused rather than guessed", async () => {
  /**
   * The first draft of this DID guess, and this test is why it stopped. «credit» partial-matches
   * «Credit card number» and «Credit limit» — both real, both parsing as numbers — so a lone
   * credit column would map the amount to a card number and import a statement of nonsense,
   * confidently. Leaving `amount` unmapped is the visible failure: §CSV-AI gets a turn, and
   * failing that the person is shown the column picker.
   */
  const m = guessMapping(["Date", "Credit card number", "Details of the operation"]);
  assert.equal(m.amount, undefined, "no amount is better than a card number as the amount");
  assert.equal(m.credit, undefined);

  // A lone DEBIT column has no such collision and is still read as a signed column.
  assert.equal(guessMapping(["Дата", "Опис", "Списання"]).amount, 2);
});

// ---- the hint table, over shapes nobody has a sample of --------------------------------------
