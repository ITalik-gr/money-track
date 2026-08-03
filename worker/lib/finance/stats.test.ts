/**
 * Tests for the canonical money definitions (E1).
 *
 * Why these and not something easier. Every case below is a rule that ALREADY BROKE in
 * production, on real data, and was caught by eye:
 *
 *   §SPLIT       — `amountSum` started using `EFF_AMOUNT`, five queries kept their old shape, and
 *                  Statistics silently went blank (`no such column: sp.amount`).
 *   §REFUND      — a cancelled purchase ("Скасування. <merchant>") counted as INCOME while the
 *                  purchase itself stayed a full expense, inflating BOTH sides of the report.
 *   §COMPENSATION— v1 excluded a whole incoming transfer from income and capped it at the
 *                  expense, so when the transfer was larger than the expense the remainder
 *                  existed in neither spending nor income. Money simply vanished.
 *
 * The point of a test here is that these are SQL strings: `tsc` cannot see inside them, and the
 * SQL linter only checks that a query mentioning the canon also carries `STATS_JOINS`. Nothing
 * checked what the numbers actually come out as.
 *
 * The module under test is imported directly — the fixture runs the REAL exported SQL. A test
 * that re-declared the expressions would only prove the copy agrees with itself.
 *
 * Run: `npm test` (Node's built-in runner and SQLite — no test dependencies to keep current).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  STATS_JOINS, SPEND_WHERE, INCOME_WHERE, EFF_AMOUNT, EFF_CAT_ID, EFF_IMPORTANCE,
  SPEND_COUNT, SPEND_TX_COUNT, spendSum, incomeSum, amountSum, uahMult,
  localYm, localMonthStart, localWeekStart, periodBounds,
} from "./stats.ts";

// Rates matching the demo dataset, so the numbers below are checkable by hand.
const RATES = { "840": 41.5, "978": 45 };
const MULT = uahMult(RATES);

/**
 * Minimal schema: exactly the columns the canonical expressions touch. Deliberately not the real
 * migrations — a fixture that drifts with every unrelated ALTER stops being read, and what is
 * being tested is the expressions, not the schema.
 */
function db(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER, color TEXT,
      is_income INTEGER DEFAULT 0, importance TEXT
    );
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY, time INTEGER, amount INTEGER, currency_code INTEGER DEFAULT 980,
      category_id INTEGER, real_category_id INTEGER, merchant TEXT,
      is_transfer INTEGER DEFAULT 0, transfer_pair_id TEXT, hold INTEGER DEFAULT 0,
      importance TEXT, planned_id INTEGER,
      reimbursed INTEGER DEFAULT 0, reimburses_total INTEGER DEFAULT 0
    );
    CREATE TABLE tx_splits (id INTEGER PRIMARY KEY, tx_id TEXT, category_id INTEGER, amount INTEGER);

    INSERT INTO categories (id, name, parent_id, is_income, importance) VALUES
      (1,  'Groceries',  NULL, 0, 'essential'),
      (2,  'Household',  NULL, 0, 'discretionary'),
      (3,  'Transport',  NULL, 0, 'discretionary'),
      (4,  'Salary',     NULL, 1, NULL),
      (13, 'Transfers',  NULL, 0, NULL),
      (50, 'Supermarket', 1,   0, NULL);   -- child of Groceries, exercises the roll-up
  `);
  return d;
}

const tx = (d: DatabaseSync, row: Record<string, string | number | null>) => {
  const cols = Object.keys(row);
  d.prepare(`INSERT INTO transactions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...cols.map((c) => row[c] as never));
};

/** node:sqlite returns rows with a null prototype, which `deepEqual` will not match against a
 *  plain object literal. Normalise at the boundary so the assertions stay readable. */
const plain = <T>(r: T): T => ({ ...r });
const plainAll = <T>(rs: T[]): T[] => rs.map(plain);

/** Canonical totals for the whole table — the same shape every `/analytics` endpoint uses. */
function totals(d: DatabaseSync) {
  return d.prepare(
    `SELECT ${spendSum(MULT)} AS spend, ${incomeSum(MULT)} AS income, ${SPEND_COUNT} AS n
     FROM transactions t ${STATS_JOINS}`,
  ).get() as { spend: number; income: number; n: number };
}

test("plain expense and income", () => {
  const d = db();
  tx(d, { id: "a", time: 1, amount: -10000, category_id: 1 });
  tx(d, { id: "b", time: 2, amount: 500000, category_id: 4 });
  const r = totals(d);
  assert.equal(r.spend, 10000);
  assert.equal(r.income, 500000);
  assert.equal(r.n, 1);
});

test("uncategorised outflow still counts as spending", () => {
  // NULL category must not fall out of the stats — `IS NOT 13` rather than `!= 13` exists for
  // exactly this, since `NULL != 13` is NULL and would drop the row.
  const d = db();
  tx(d, { id: "a", time: 1, amount: -4200, category_id: null });
  assert.equal(totals(d).spend, 4200);
});

test("§SPLIT: a split expense is counted once, not once per part", () => {
  const d = db();
  tx(d, { id: "s", time: 1, amount: -30000, category_id: 1 });
  d.prepare("INSERT INTO tx_splits (tx_id, category_id, amount) VALUES (?,?,?)").run("s", 1, -20000);
  d.prepare("INSERT INTO tx_splits (tx_id, category_id, amount) VALUES (?,?,?)").run("s", 2, -10000);

  const r = totals(d);
  assert.equal(r.spend, 30000, "sum of parts, not the transaction plus its parts");
  // The join multiplies the row into its parts, so a naive COUNT(*) would say 2 here.
  assert.equal(r.n, 2, "SPEND_COUNT counts split rows — use COUNT(DISTINCT t.id) for operations");

  // And the parts land in their OWN categories, which is the whole point of splitting.
  const byCat = d.prepare(
    `SELECT ${EFF_CAT_ID} AS cat, ${amountSum(MULT)} AS spent
     FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE} GROUP BY ${EFF_CAT_ID} ORDER BY cat`,
  ).all() as { cat: number; spent: number }[];
  assert.deepEqual(plainAll(byCat), [{ cat: 1, spent: 20000 }, { cat: 2, spent: 10000 }]);
});

test("§APP_TZ: calendar boundaries follow Kyiv, not the runtime's UTC", () => {
  // The reported bug: at 02:46 on 1 August the Statistics page showed JULY for every period
  // type. The Worker runtime is UTC, where that instant is still 31 July 23:46, so "this month"
  // was honestly computed as July. Every night between 00:00 and 03:00 the app was a day behind.
  const night = Math.floor(Date.parse("2026-07-31T23:46:00Z") / 1000); // 1 Aug 02:46 in Kyiv

  assert.equal(localYm(night), "2026-08", "the local month has already turned over");
  assert.equal(
    new Date(localMonthStart(night) * 1000).toISOString(), "2026-07-31T21:00:00.000Z",
    "month starts at local midnight (21:00Z in summer), not at 00:00Z",
  );
  assert.equal(new Date(periodBounds("calendar", "month", night).from * 1000).toISOString(), "2026-07-31T21:00:00.000Z");

  // 1 Aug 2026 is a Saturday, so the ISO week began Monday 27 July, local midnight.
  assert.equal(new Date(localWeekStart(night) * 1000).toISOString(), "2026-07-26T21:00:00.000Z");

  // DST: Kyiv is +3 in summer and +2 in winter. A fixed offset would put January an hour out.
  const winter = Math.floor(Date.parse("2026-01-15T12:00:00Z") / 1000);
  assert.equal(new Date(localMonthStart(winter) * 1000).toISOString(), "2025-12-31T22:00:00.000Z");
});

test("§CADENCE: SPEND_TX_COUNT counts charges, not joined rows", () => {
  // What this protects: a weekly report decides whether a category's delta is meaningful by how
  // many charges produced it. Overcount and a once-a-month subscription looks like a daily habit,
  // which is exactly the reading that produced "підписки впали на 92%" in a real report.
  const d = db();
  tx(d, { id: "sub", time: 1, amount: -9900, category_id: 2 });        // one monthly charge
  tx(d, { id: "s", time: 2, amount: -30000, category_id: 2 });         // one charge, split in two
  d.prepare("INSERT INTO tx_splits (tx_id, category_id, amount) VALUES (?,?,?)").run("s", 2, -20000);
  d.prepare("INSERT INTO tx_splits (tx_id, category_id, amount) VALUES (?,?,?)").run("s", 2, -10000);
  tx(d, { id: "ref", time: 3, amount: 5000, category_id: 2 });         // refund — not a charge

  const r = d.prepare(
    `SELECT ${SPEND_TX_COUNT} AS n, ${amountSum(MULT)} AS spent
     FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE}`,
  ).get() as { n: number; spent: number };
  assert.equal(r.n, 2, "two charges: the split is one, the refund is none");
  assert.equal(r.spent, 34900, "9900 + 30000 - 5000");
});

test("§REFUND: a refund reduces its category, is not income, and is not an operation", () => {
  const d = db();
  tx(d, { id: "buy", time: 1, amount: -14500, category_id: 3 });
  tx(d, { id: "ref", time: 2, amount: 14500, category_id: 3 });      // categorised refund
  tx(d, { id: "ref2", time: 3, amount: 5000, merchant: "Скасування. BlaBlaCar" }); // by description

  const r = totals(d);
  assert.equal(r.income, 0, "a refund is not earnings");
  assert.equal(r.spend, -5000, "both refunds subtract: 14500 - 14500 - 5000");
  assert.equal(r.n, 1, "only the real outflow is an operation — otherwise the average ticket sinks");
});

test("§REFUND: an uncategorised incoming P2P is real income, not a refund", () => {
  // The trap that made this rule fragile: `COALESCE(cat, 0)` would classify every uncategorised
  // incoming transfer as a refund, because 0 is not an income category.
  const d = db();
  tx(d, { id: "p2p", time: 1, amount: 240000, merchant: "Від: Кирило" });
  assert.equal(totals(d).income, 240000);
});

test("§COMPENSATION v2: allocated part reduces the expense, remainder stays income", () => {
  // The production bug: an incoming transfer LARGER than the expense it covers. v1 excluded the
  // whole transfer from income and capped it at the expense, so the remainder appeared in
  // neither spending nor income.
  const d = db();
  tx(d, { id: "exp", time: 1, amount: -187000, category_id: 2, reimbursed: 187000 });
  tx(d, { id: "in", time: 2, amount: 240000, reimburses_total: 187000 });

  const r = totals(d);
  assert.equal(r.spend, 0, "the expense was fully covered");
  assert.equal(r.income, 53000, "the unallocated remainder is genuine income");
  // Nothing is lost: expense + income must still account for the whole incoming amount.
  assert.equal(r.income + 187000, 240000);
});

test("§COMPENSATION: a partly refunded expense nets out in totals and in its category", () => {
  // Reported by a user as "statistics still show the full price". They do not: the canon
  // subtracts the compensation, verified here end to end. What was actually
  // missing was any sign of it in the UI — the list and the detail header showed the amount the
  // BANK charged, so a user who had just recorded a compensation saw an unchanged number.
  const d = db();
  tx(d, { id: "exp", time: 1, amount: -137500, category_id: 1, reimbursed: 100000 });
  tx(d, { id: "src", time: 2, amount: 100000, merchant: "Від: друг", reimburses_total: 100000 });
  const r = totals(d);
  assert.equal(r.spend, 37500, "only the uncovered remainder is actually yours");
  assert.equal(r.income, 0, "the money sent back is not earnings");
  const byCat = d.prepare(
    `SELECT ${EFF_CAT_ID} AS cat, ${amountSum(MULT)} AS spent
     FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE} GROUP BY ${EFF_CAT_ID}`,
  ).all() as { cat: number; spent: number }[];
  assert.deepEqual(plainAll(byCat), [{ cat: 1, spent: 37500 }], "the category shows the net figure too");
});

test("§COMPENSATION: a partly covered expense keeps its remainder as spending", () => {
  const d = db();
  tx(d, { id: "exp", time: 1, amount: -29230, category_id: 1, reimbursed: 10000 });
  assert.equal(totals(d).spend, 19230);
});

test("transfers: a paired transfer and the bucket-13 leg are both outside the canon", () => {
  const d = db();
  tx(d, { id: "out", time: 1, amount: -50000, transfer_pair_id: "p1" });
  tx(d, { id: "in", time: 2, amount: 50000, transfer_pair_id: "p1" });
  tx(d, { id: "jar", time: 3, amount: 70000, category_id: 13 }); // jar payout, is_transfer=0
  tx(d, { id: "wd", time: 4, amount: -20000, is_transfer: 1, real_category_id: null }); // open cash move

  const r = totals(d);
  assert.equal(r.spend, 0);
  assert.equal(r.income, 0, "moving your own money is not earnings");
});

test("a withdrawal with a real category is spending in THAT category", () => {
  const d = db();
  tx(d, { id: "wd", time: 1, amount: -20000, category_id: 13, is_transfer: 1, real_category_id: 1 });
  const r = d.prepare(
    `SELECT ${EFF_CAT_ID} AS cat, ${amountSum(MULT)} AS spent
     FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE}`,
  ).get() as { cat: number; spent: number };
  assert.deepEqual(plain(r), { cat: 1, spent: 20000 });
});

test("sub-category spending rolls up into its parent", () => {
  const d = db();
  tx(d, { id: "a", time: 1, amount: -10000, category_id: 50 }); // Supermarket → Groceries
  tx(d, { id: "b", time: 2, amount: -5000, category_id: 1 });
  const rows = d.prepare(
    `SELECT ${EFF_CAT_ID} AS cat, ${amountSum(MULT)} AS spent
     FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE} GROUP BY ${EFF_CAT_ID}`,
  ).all() as { cat: number; spent: number }[];
  assert.deepEqual(plainAll(rows), [{ cat: 1, spent: 15000 }]);
});

test("foreign currency is converted, unknown currency contributes nothing", () => {
  const d = db();
  tx(d, { id: "usd", time: 1, amount: -1000, currency_code: 840, category_id: 2 }); // $10 → 415 ₴
  tx(d, { id: "uah", time: 2, amount: -10000, category_id: 2 });
  tx(d, { id: "xxx", time: 3, amount: -9999, currency_code: 999, category_id: 2 }); // no rate
  // A missing rate resolves to 0 rather than to 1: silently treating $1 as ₴1 is the failure
  // this multiplier exists to prevent.
  assert.equal(totals(d).spend, 41500 + 10000);
});

test("§6 importance: transaction override beats the category default", () => {
  const d = db();
  tx(d, { id: "a", time: 1, amount: -10000, category_id: 1 });                        // essential
  tx(d, { id: "b", time: 2, amount: -10000, category_id: 1, importance: "optional" }); // override
  tx(d, { id: "c", time: 3, amount: -10000, category_id: null });                      // default
  const rows = d.prepare(
    `SELECT ${EFF_IMPORTANCE} AS imp, ${amountSum(MULT)} AS spent
     FROM transactions t ${STATS_JOINS} WHERE ${SPEND_WHERE} GROUP BY ${EFF_IMPORTANCE} ORDER BY imp`,
  ).all() as { imp: string; spent: number }[];
  assert.deepEqual(plainAll(rows), [
    { imp: "discretionary", spent: 10000 }, // uncategorised falls back
    { imp: "essential", spent: 10000 },
    { imp: "optional", spent: 10000 },
  ]);
});

test("SPEND_WHERE and INCOME_WHERE never claim the same row", () => {
  // The property that makes the two filters a partition rather than two opinions. Both bugs
  // above were violations of it: a refund counted twice, a compensation counted nowhere.
  const d = db();
  tx(d, { id: "a", time: 1, amount: -10000, category_id: 1 });
  tx(d, { id: "b", time: 2, amount: 500000, category_id: 4 });
  tx(d, { id: "c", time: 3, amount: 14500, category_id: 3 });                        // refund
  tx(d, { id: "e", time: 4, amount: 240000, reimburses_total: 187000 });             // partly allocated
  tx(d, { id: "f", time: 5, amount: 70000, category_id: 13 });                       // own money
  const both = d.prepare(
    `SELECT COUNT(*) n FROM transactions t ${STATS_JOINS}
     WHERE (${SPEND_WHERE}) AND (${INCOME_WHERE})`,
  ).get() as { n: number };
  assert.equal(both.n, 0);
});

test("EFF_AMOUNT stays negative for a fully reimbursed expense", () => {
  // If a reimbursement could exceed its expense, EFF_AMOUNT would turn positive and the row
  // would leave the statistics entirely — which is why the endpoint caps it.
  const d = db();
  tx(d, { id: "x", time: 1, amount: -10000, category_id: 1, reimbursed: 10000 });
  const r = d.prepare(
    `SELECT ${EFF_AMOUNT} AS eff FROM transactions t ${STATS_JOINS}`,
  ).get() as { eff: number };
  assert.equal(r.eff, 0);
});
