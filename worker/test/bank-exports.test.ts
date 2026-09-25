/**
 * Real banks' export headers read by the hint table alone (§CSV-AI is only the fallback): the right
 * amount column (card currency), the sign and the row count.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { findHeaderRow, toCanonical, type ColumnMapping } from "../lib/bank/providers/csv.ts";

async function read(rows: string[][]) {
  const { index, mapping } = findHeaderRow(rows);
  const res = await toCanonical(rows.slice(index), mapping as ColumnMapping, "acc", 980, true, "en");
  return { index, mapping, header: rows[index]!, ...res };
}

test("Raiffeisen (English export): preamble skipped, card-currency amount, MCC kept", async () => {
  const r = await read([
    ["Raiffeisen Bank JSC"], ["Account statement for 13.08.2026 19:01:53"], ["Client: TEST"], [""],
    ["Date and time of transaction", "Date of transaction execution by the bank", "Card number",
      "Details of the operation", "MCC", "Amount in card currency", "Amount in transaction currency",
      "Currency", "Rate", "Fees", "Cashback", "Balance"],
    ["13.08.2026 08:52:03", "13.08.2026", "", "Salary from EMPLOYER", "", "2084.00", "2084.00", "", "", "0.00", "", "11121.93"],
    ["10.08.2026 12:00:00", "11.08.2026", "4149 51** **** 8237", "SPOTIFY", "5815", "-199.00", "-4.99", "USD", "39.9", "0.00", "", "9037.93"],
  ]);
  assert.equal(r.index, 4);
  assert.equal(r.header[r.mapping.amount!], "Amount in card currency");
  assert.deepEqual(r.txs.map((t) => [t.amount, t.mcc]), [[208400, null], [-19900, 5815]]);
});

test("monobank: Latin «i» in the date header, «(UAH)» suffix on the amount", async () => {
  const r = await read([
    ["Дата i час операції", "Деталі операції", "MCC", "Сума в валюті картки (UAH)",
      "Сума в валюті операції", "Валюта", "Курс", "Сума комісій (UAH)", "Сума кешбеку (UAH)",
      "Залишок після операції"],
    ["14.09.2026 09:12:00", "Bolt", "4121", "-181.00", "-181.00", "UAH", "—", "—", "—", "5000.00"],
    ["14.09.2026 09:15:00", "Скасування. Bolt", "4121", "181.00", "181.00", "UAH", "—", "—", "—", "5181.00"],
  ]);
  assert.equal(r.header[r.mapping.date!], "Дата i час операції");
  assert.equal(r.header[r.mapping.amount!], "Сума в валюті картки (UAH)");
  assert.equal(r.header[r.mapping.description!], "Деталі операції");
  assert.deepEqual(r.txs.map((t) => t.amount), [-18100, 18100]);
});

test("PrivatBank: «Сума в валюті картки» wins over the transaction-currency column", async () => {
  const r = await read([
    ["Виписка з Ваших карток за період 01.09.2026 - 15.09.2026"],
    ["Дата", "Категорія", "Картка", "Опис операції", "Сума в валюті картки", "Валюта картки",
      "Сума в валюті транзакції", "Валюта транзакції", "Залишок на кінець періоду", "Валюта залишку"],
    ["02.09.2026 10:00:00", "Супермаркети", "5168 **** **** 1234", "Сільпо", "-512,40", "UAH", "-512,40", "UAH", "1000,00", "UAH"],
    ["03.09.2026 11:00:00", "Інтернет", "5168 **** **** 1234", "Netflix", "-420,00", "UAH", "-9,99", "USD", "580,00", "UAH"],
  ]);
  assert.equal(r.index, 1);
  assert.equal(r.header[r.mapping.amount!], "Сума в валюті картки");
  assert.equal(r.header[r.mapping.description!], "Опис операції");
  assert.deepEqual(r.txs.map((t) => t.amount), [-51240, -42000]);
});

test("Revolut: declined and reverted card attempts are not purchases", async () => {
  const r = await read([
    ["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "State", "Balance"],
    ["CARD_PAYMENT", "Current", "2026-09-01 10:00:00", "2026-09-02 10:00:00", "Uber", "-12.50", "0.00", "EUR", "COMPLETED", "100.00"],
    ["CARD_PAYMENT", "Current", "2026-09-01 10:01:00", "", "Uber", "-12.50", "0.00", "EUR", "DECLINED", "100.00"],
    ["CARD_PAYMENT", "Current", "2026-09-03 09:00:00", "", "Shop", "-30.00", "0.00", "EUR", "REVERTED", "100.00"],
    ["TOPUP", "Current", "2026-09-04 09:00:00", "2026-09-04 09:00:00", "Top-up", "200.00", "0.00", "EUR", "COMPLETED", "300.00"],
  ]);
  assert.equal(r.header[r.mapping.status!], "State");
  assert.deepEqual(r.txs.map((t) => t.amount), [-1250, 20000]);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped[0]!.reason, /DECLINED/);
});
