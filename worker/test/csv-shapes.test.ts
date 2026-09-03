/**
 * §CSV-DEBIT — the two shapes a bank statement comes in, and the one that used to be read wrong.
 *
 * A statement carries the amount in one of two ways, and the app has to read both:
 *
 *   · ONE SIGNED COLUMN — «Сума» with a minus for money out. This is what monobank and most card
 *     exports do, it is what every existing file uses, and nothing here may change it.
 *   · TWO COLUMNS — «Дебет» and «Кредит», both POSITIVE, and the sign lives in WHICH column is
 *     filled. This is a large family: Ukrainian bank exports and essentially every accounting CSV.
 *
 * The second one was not merely unsupported, it was silently MISREAD. The `amount` hint list
 * contained "debit" and "credit", so such a file mapped to whichever came first and imported half
 * its rows — each with the sign inverted, since `250,00` in a column called «Дебет» is money
 * leaving. Nothing threw. The preview, whose entire job is to catch a wrong amount column before a
 * month of wrong numbers reaches the canon, showed a confident and wrong answer.
 *
 * That is why the assertions below are about SIGN and about ROW COUNT, not about the mapping alone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { guessMapping, toCanonical, findHeaderRow, parseCsv, type ColumnMapping } from "../lib/bank/providers/csv.ts";

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

test("§CSV-DEBIT: «Дебет»/«Кредит» are recognised as a PAIR", async () => {
  const m = guessMapping(LEDGER[0]);
  assert.equal(m.amount, 2, "the debit column is the amount column");
  assert.equal(m.credit, 3);
});

test("§CSV-DEBIT: the SIGN comes from the column, not from the cell", async () => {
  const { txs, skipped } = await conv(LEDGER, guessMapping(LEDGER[0]));
  // All three rows survive. Before this, only the ones with a debit did — and as INCOME.
  assert.equal(skipped.length, 0, "an empty cell on one side is how a ledger says «other kind»");
  assert.deepEqual(txs.map((t) => t.amount), [-25000, 1000000, -10000]);
});

test("§CSV-DEBIT: a bank that already prints the debit negative means the same thing", async () => {
  // Both spellings exist in the wild — `250,00` and `-250,00` under the same «Дебет» header — and
  // they agree. Hence `-Math.abs`, never a negation: negating an already-negative cell would turn
  // an expense into income for exactly the banks that were being explicit.
  const rows = [LEDGER[0], ["01.05.2026", "Сільпо", "-250,00", ""], ["02.05.2026", "Зарплата", "", "10000,00"]];
  const { txs } = await conv(rows, guessMapping(rows[0]));
  assert.deepEqual(txs.map((t) => t.amount), [-25000, 1000000]);
});

test("§CSV-DEBIT: a row empty on BOTH sides is skipped, not imported as zero", async () => {
  const rows = [LEDGER[0], ["01.05.2026", "Порожня", "", ""]];
  const { txs, skipped } = await conv(rows, guessMapping(rows[0]));
  assert.equal(txs.length, 0);
  assert.equal(skipped.length, 1);
});

test("§CSV-DEBIT: English Debit/Credit, and a signed column still WINS over a pair", async () => {
  const en = guessMapping(["Date", "Description", "Debit", "Credit"]);
  assert.equal(en.amount, 2);
  assert.equal(en.credit, 3);

  // A file with all three: the signed column is the commoner export and the unambiguous one, so it
  // takes precedence and the pair is never consulted.
  const both = guessMapping(["Date", "Description", "Amount", "Debit", "Credit"]);
  assert.equal(both.amount, 2);
  assert.equal(both.credit, undefined);
});

test("§CSV-DEBIT: ONE half alone is read as an ordinary signed column", async () => {
  // A file with only «Витрата» is a list of expenses whose sign the file itself does not state.
  // Assuming they are all outgoing would be a claim the data does not make; it is read as-is, and
  // the preview shows the person what that produced.
  const m = guessMapping(["Дата", "Опис", "Витрата"]);
  assert.equal(m.amount, 2);
  assert.equal(m.credit, undefined);
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

test("§CSV-DEBIT: the widened hints recognise ordinary Ukrainian and European headers", () => {
  // Each of these costs a model call (§CSV-AI) when unrecognised, and a hint when recognised. The
  // hint is free and reproducible, which is why the table is widened rather than left to the AI.
  const cases: [string[], Partial<ColumnMapping>][] = [
    [["Дата проводки", "Призначення платежу", "Сума, грн", "Валюта операції"], { date: 0, description: 1, amount: 2, currency: 3 }],
    [["Booking date", "Narrative", "Amount in account currency", "CCY"], { date: 0, description: 1, amount: 2, currency: 3 }],
    [["Transaction date", "Payee", "Paid out", "Paid in"], { date: 0, description: 1, amount: 2, credit: 3 }],
  ];
  for (const [headers, want] of cases) {
    const got = guessMapping(headers);
    for (const [k, v] of Object.entries(want)) {
      assert.equal(got[k as keyof ColumnMapping], v, `${headers.join("|")} → ${k}`);
    }
  }
});

test("§CSV-DEBIT: a preamble above a two-column ledger still finds the header", async () => {
  // `findHeaderRow` scores rows by how many columns they map, and the pair has to count towards
  // that score — otherwise the widest-known statement shape scores 2 and loses to a preamble line.
  const text = [
    "ПАТ «Банк»",
    "Виписка за рахунком UA123",
    "Період: 01.05.2026 - 31.05.2026",
    "Дата;Опис;Дебет;Кредит",
    "01.05.2026;Сільпо;250,00;",
  ].join("\n");
  const rows = parseCsv(text, ";");
  const found = findHeaderRow(rows);
  assert.equal(found.index, 3, "the header is the row that maps the most columns");
  assert.equal(found.mapping.amount, 2);
  assert.equal(found.mapping.credit, 3);
});
