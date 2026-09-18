/**
 * CSV column headings and row-level import errors — the `csv*` half of the server dictionary.
 *
 * Split out of `i18n.ts` on 2026-09-18 the moment the quarter-summary export pushed that file over
 * C3's 400 lines. The seam is a prefix, which is what C3 asks for: every key here is a column
 * heading or a row error in a FILE — read by a spreadsheet, and often by somebody else's
 * accountant — while everything left in `i18n.ts` is text for a screen. They are different
 * audiences with different conventions: a column heading carries its unit («Дохід, грн») because
 * a spreadsheet has nowhere else to put one.
 *
 * ⚠️ These are not the CSV header ALIASES that `normalize.ts` matches an incoming file against.
 * Those are compared with bank data and must never be translated (`i18n.ts` says so at the top,
 * and it is still true here).
 */
export const CSV_STRINGS = {
  // ---- ФОП: the income book (§TAX-FX) --------------------------------------
  // §TAX-FX — the income book an accountant asks for. Column names, not prose: they label a
  // document, and the hryvnia column is hryvnia whatever the reader's display base is (§TAX-UAH).
  csvTaxRate: { uk: "Курс НБУ", en: "NBU rate" },
  csvTaxRateDate: { uk: "Курс на дату", en: "Rate for date" },
  csvTaxBase: { uk: "Сума, грн", en: "Amount, UAH" },
  // ---- ФОП: the quarter summary (§TAX-DUE) ---------------------------------
  // Named as an accountant names them, not as the code does.
  csvQuarter: { uk: "Квартал", en: "Quarter" },
  csvIncome: { uk: "Дохід, грн", en: "Income, UAH" },
  csvReceipts: { uk: "Надходжень", en: "Receipts" },
  csvSingleTax: { uk: "Єдиний податок, грн", en: "Single tax, UAH" },
  csvLevy: { uk: "Військовий збір, грн", en: "Military levy, UAH" },
  csvEsv: { uk: "ЄСВ, грн", en: "Social contribution, UAH" },
  csvPaid: { uk: "Сплачено, грн", en: "Paid, UAH" },
  csvOutstanding: { uk: "Лишилось сплатити, грн", en: "Outstanding, UAH" },
  // ---- the transaction export ----------------------------------------------
  csvDate: { uk: "Дата", en: "Date" },
  csvMerchant: { uk: "Мерчант", en: "Merchant" },
  csvComment: { uk: "Коментар", en: "Comment" },
  csvNote: { uk: "Нотатка", en: "Note" },
  csvAmount: { uk: "Сума", en: "Amount" },
  csvCurrency: { uk: "Валюта", en: "Currency" },
  csvCategory: { uk: "Категорія", en: "Category" },
  csvAccount: { uk: "Рахунок", en: "Account" },
  csvGroup: { uk: "Група", en: "Group" },
  csvTransfer: { uk: "Переказ", en: "Transfer" },
  csvYes: { uk: "так", en: "yes" },
  // ---- CSV import: why a row was skipped -----------------------------------
  csvBadDate: { uk: "не розпізнав дату: «{value}»", en: "could not parse the date: “{value}”" },
  csvBadAmount: { uk: "не розпізнав суму: «{value}»", en: "could not parse the amount: “{value}”" },
  csvZeroAmount: { uk: "нульова сума", en: "zero amount" },
  csvNotSettled: { uk: "операція не проведена ({value})", en: "not settled ({value})" },
} as const;
