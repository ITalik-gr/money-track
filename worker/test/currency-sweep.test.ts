/**
 * §BASE-CUR, the exhaustive half: EVERY money figure the API returns must be in the reader's base.
 *
 * Why this exists rather than another dozen hand-written assertions. The display currency works by
 * changing what one function returns (`getRates`) and leaving forty call sites alone — so a leak is
 * never a crash and never a type error. It is one field, on one screen, still in hryvnia, sitting
 * next to a dollar sign. Reported from the live app as "a lot of places still show hryvnia,
 * especially Statistics", and that report is the only reason the first pass was known to be
 * incomplete: nothing in the build could tell.
 *
 * THE INVARIANT THAT MAKES THIS MECHANICAL. `ratesInBase(stored, X)` is `ratesInBase(stored, 980)`
 * divided by the rate of X — every entry, uniformly. So for a fixture where $1 = ₴2, EVERY money
 * number in EVERY response must be exactly half of what it is in hryvnia. Not "roughly", not "for
 * the fields we remembered to check": half. A field that comes back identical is either not money
 * or is a bug, and the only maintained artifact here is the list saying which.
 *
 * ⚠️ The list below is the deliverable. Adding a name to it is a claim that the field is NOT money
 * (a count, a ratio, an id, a timestamp), and that claim is reviewable. Silence is not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv, freezeTime, type MemDb } from "./harness.ts";
import { seed, seedRareTables, FROZEN_NOW_ISO } from "./fixture.ts";

/** $1 = ₴2, so "converted" and "not converted" differ by a factor no rounding can hide. */
const RATE = 2;
const USD = 840;

/**
 * Numeric fields that are NOT money, by the last segment of their JSON path.
 *
 * Grouped by what they are, because the grouping is the argument: a reviewer has to be able to
 * see at a glance that nothing in here is an amount.
 */
const NOT_MONEY = new Set([
  // identity and time
  "id", "category_id", "real_category_id", "parent_id", "account_id", "goal_id", "event_id",
  "tx_id", "planned_id", "source_tx_id", "expense_id", "connection_id",
  "currency_code", "original_currency", "code", "base", "cur",
  "time", "at", "created_at", "updated", "deadline", "from", "to", "t", "day", "date",
  "now", "first_at", "last_at", "prevFrom", "prevTo", "month_start", "monthStart", "ref_from",
  "effective_from", "expires_at", "confirmed_at", "start_date", "end_date", "next_at",
  "period_from", "period_to", "last_seen_at", "last_sync_at", "recorded_at", "closed_at",
  "statement_day", "payment_day", "period_count", "months", "days", "days_left", "in_days",
  "week", "year", "month_index", "dow", "dom", "daysInMonth", "daysElapsed", "daysRemaining",
  "busiest",          // a weekday or day-of-MONTH index (§WEEKDAY), not an amount
  "first_five_share_pct",
  // counts
  "n", "prev_n", "qty", "receipts", "total_items", "count", "tx_count", "income_n", "charges_n", "prev_charges_n", "accounts", "active_months",
  "months_closed", "months_over", "closed", "over", "transactions", "operations", "limit",
  "priority", "mcc", "position", "sort", "level_n", "n_months", "sessions",
  // ratios, percentages, scores — unitless by construction
  "pct", "ratio", "projected_ratio", "delta_pct", "price_change_pct", "used_pct", "progress_frac",
  "elapsed_frac", "cv", "score", "trim_pct", "runway_months", "per_month_pct", "stability",
  "cost_pct", "savings_rate_pct", "share_pct", "income_pct", "share", "category_share", "weight", "confidence", "cv_pct",
  "kept_pct",
  "weekend_share_pct",
]);

/**
 * Fields whose value is money but which the API deliberately reports in MAJOR units already
 * (`*_uah` in AI-facing payloads). They still scale — this set exists only to widen the rounding
 * tolerance, because dividing whole hryvnia by 2 can legitimately land half a unit away.
 */
const MAJOR_UNITS = /_uah$/;

/**
 * Fields the app deliberately ROUNDS to a readable step, and the step differs per base: a budget
 * proposal rounds to ₴50 in hryvnia and to a whole unit elsewhere, because ₴50 converts to $1.21
 * and a suggestion that is not round stops reading as a decision. They still have to move — the
 * tolerance is one rounding step, not a free pass.
 */
const ROUNDED = new Set(["suggested", "total_suggested"]);
const ROUND_STEP = 100;

interface Leak { path: string; uah: number; usd: number }

/**
 * THE ONE DISTINCTION THAT MATTERS: is this number in a currency of its OWN?
 *
 * A row that carries `currency_code` is a bank record — a transaction, an account, a plan — and
 * its amount is stored and shown in that currency. Converting it would be the bug in the other
 * direction (§Інваріанти: `original_amount` exists precisely so the operation keeps its own
 * currency). Anything NOT sitting beside a `currency_code` is a roll-up, and a roll-up has no
 * currency except the reader's.
 *
 * The exception inside the exception: a row may carry BOTH — `/planned/upcoming` returns the plan's
 * own `period_amount` next to `amount_uah`, the rolled-up equivalent. Those still have to move.
 */
// ⚠️ `reimbursed`/`reimburses_total` are NOT here: they live on a transaction row and are
// denormalised in that row's own currency (§COMPENSATION), which is why `EFF_AMOUNT` adds them
// BEFORE multiplying. Converting them here would double-convert the compensation.
const ROLLED_UP_INSIDE_A_ROW = /_uah$|_base$|^spent$|^income$/;

function ownCurrency(node: unknown): boolean {
  return !!node && typeof node === "object" && !Array.isArray(node)
    && "currency_code" in (node as Record<string, unknown>);
}

function compare(uah: unknown, usd: unknown, path: string, out: Leak[], inRow = false): void {
  if (typeof uah === "number" && typeof usd === "number") {
    const key = path.split(".").pop()!.replace(/\[\d+\]$/, "");
    if (NOT_MONEY.has(key)) return;
    if (inRow && !ROLLED_UP_INSIDE_A_ROW.test(key)) return;
    if (uah === 0 && usd === 0) return;            // nothing to convert, nothing to prove
    if (!Number.isInteger(uah) && !Number.isInteger(usd)) return;   // a rate or a fraction
    const expected = uah / RATE;
    // A deliberately rounded number keeps only its magnitude, so it is checked proportionally:
    // one rounding step, or 1% for a total that sums many of them. An UNCONVERTED value is off by
    // the whole rate, so this still catches exactly what the sweep is for.
    const tolerance = ROUNDED.has(key) ? Math.max(ROUND_STEP, Math.abs(expected) * 0.01)
      : MAJOR_UNITS.test(key) ? 1 : 0.5;
    if (Math.abs(usd - expected) > tolerance) out.push({ path, uah, usd });
    return;
  }
  if (Array.isArray(uah) && Array.isArray(usd)) {
    for (let i = 0; i < Math.min(uah.length, usd.length); i++) {
      compare(uah[i], usd[i], `${path}[${i}]`, out, inRow);
    }
    return;
  }
  if (uah && usd && typeof uah === "object" && typeof usd === "object") {
    const row = inRow || ownCurrency(uah);
    for (const k of Object.keys(uah as object)) {
      compare((uah as Record<string, unknown>)[k], (usd as Record<string, unknown>)[k],
        path ? `${path}.${k}` : k, out, row);
    }
  }
}

/**
 * Every read-only endpoint that returns money. Deliberately the golden list plus the ones the
 * owner named — the Statistics tabs read `/analytics/*` almost exclusively, which is why "especially
 * Statistics" was the symptom of a general problem rather than a page-specific one.
 */
const ENDPOINTS: string[] = [
  "/summary", "/accounts/funds", "/rates",
  "/transactions?limit=50", "/transactions/frequent",
  "/budgets", "/budgets/status", "/budgets/history", "/budgets/auto", "/budgets/auto?trim=25",
  "/categories/1/overview", "/categories/13/overview",
  "/planned", "/planned/upcoming", "/planned/actuals", "/planned/detect",
  "/goals", "/goals/1/progress", "/goals/1/contributions", "/events",
  "/notifications", "/facts",
  "/analytics/overview", "/analytics/overview?preset=week", "/analytics/overview?preset=quarter",
  "/analytics/overview?preset=year",
  "/analytics/monthly-history", "/analytics/safe-to-spend", "/analytics/capital-trend",
  "/analytics/networth", "/analytics/compare", "/analytics/forecast", "/analytics/income",
  "/analytics/cashflow-calendar", "/analytics/receipt-items", "/analytics/price-drift", "/analytics/fx-cost",
  "/analytics/patterns", "/analytics/by-category", "/analytics/habits", "/analytics/weekday",
  "/analytics/weekday?preset=month", "/analytics/day-of-month", "/analytics/spark", "/analytics/health",
  "/analytics/category?id=1", "/analytics/merchant?name=Сільпо",
  "/analytics/category?category=1",   // the Statistics donut drill (§CAT-PAGE)
];

function fixture(): MemDb {
  const db = migratedDb();
  seed(db);
  // One rate, and a round one. The fixture's real rates (40/45) would work too, but a factor of 2
  // makes a failure readable at a glance: 12 000 vs 6 000, not 12 000 vs 300.
  db.raw.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('rates', ?)")
    .run(JSON.stringify({ [USD]: RATE }));
  seedRareTables(db);
  return db;
}


test("§BASE-CUR sweep: every money field halves when the base does", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const db = fixture();
    const inUah = testEnv(db);
    const inUsd = { ...testEnv(db), UI_CURRENCY: USD };

    const leaks: Leak[] = [];
    for (const path of ENDPOINTS) {
      await t.test(path, async () => {
        const a = await (await api.request(path, {}, inUah)).text();
        const b = await (await api.request(path, {}, inUsd)).text();
        const found: Leak[] = [];
        compare(JSON.parse(a), JSON.parse(b), "", found);
        leaks.push(...found.map((l) => ({ ...l, path: `${path} → ${l.path}` })));
        assert.deepEqual(found, [],
          `${path} returns money that did not follow the base.\n` +
          found.map((l) => `    ${l.path}: ₴${l.uah} stayed ${l.usd} (expected ${l.uah / RATE})`).join("\n"));
      });
    }
    assert.equal(leaks.length, 0);
  } finally {
    restore();
  }
});
