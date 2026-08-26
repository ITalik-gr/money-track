/**
 * §SUB-MONTH and §CUR-PLAN — the monthly burden of a plan, which is one function and was three.
 *
 * ⚠️ **This file is new on 2026-08-21, and CLAUDE.md has claimed since 2026-08-01 that it holds
 * the rule.** It did not exist. That is worth recording plainly: a documented safeguard nobody
 * checked is worse than an undocumented gap, because it is read as coverage — and in the meantime
 * the Subscriptions page grew a second definition whose end-of-plan test had drifted, which is
 * exactly what such a test is for.
 *
 * The two failures being pinned, both silent:
 *  · §CUR-PLAN — a $5 plan weighing 5 ₴, because `period_amount` is in the PLAN's currency;
 *  · §SUB-MONTH — a quarterly plan weighing its full amount every month, and a weekly one
 *    weighing a single charge instead of ~4.3.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  monthlyPlannedUAH, sumMonthlyPlannedUAH, plannedUAH, nextChargeUnix, chargesBetween,
  planMatches, planNeedles,
} from "../lib/finance/subscriptions.ts";

/** ₴ per unit, as `getRates` hands them over (its own row for 980). */
const RATES = { "980": 1, "840": 40, "978": 45 };
const NOW = Math.floor(Date.parse("2026-05-14T09:00:00Z") / 1000);

const plan = (o: Partial<Parameters<typeof monthlyPlannedUAH>[0]> = {}) => ({
  period_amount: 50000, currency_code: 980, period: "month", period_count: 1,
  end_date: null, ...o,
} as Parameters<typeof monthlyPlannedUAH>[0]);

test("§CUR-PLAN: the amount is in the PLAN's currency, never raw hryvnia", () => {
  // The bug verbatim: five places summed `period_amount` directly, so a $5 subscription weighed 5 ₴.
  assert.equal(plannedUAH(500, 840, RATES), 20000);
  assert.equal(monthlyPlannedUAH(plan({ period_amount: 500, currency_code: 840 }), RATES, NOW), 20000);
  // A missing currency is the hryvnia, which is what an unstamped legacy row means.
  assert.equal(monthlyPlannedUAH(plan({ currency_code: null }), RATES, NOW), 50000);
});

test("§SUB-MONTH: the period is AVERAGED, not taken at face value", () => {
  // Monthly is itself.
  assert.equal(monthlyPlannedUAH(plan(), RATES, NOW), 50000);
  // Quarterly ("every 3 months") is a third of its charge per month — it used to count in full
  // every month, which is how the app claimed subscriptions cost more than they did.
  assert.equal(monthlyPlannedUAH(plan({ period_count: 3 }), RATES, NOW), Math.round(50000 / 3));
  // Weekly is ~4.35 charges a month, not one.
  const weekly = monthlyPlannedUAH(plan({ period: "week", period_amount: 10000 }), RATES, NOW);
  assert.ok(weekly > 43000 && weekly < 44000, `weekly burden was ${weekly}`);
  // Every other week: half of that, to the копійка.
  const fortnightly = monthlyPlannedUAH(plan({ period: "week", period_amount: 10000, period_count: 2 }), RATES, NOW);
  assert.ok(Math.abs(fortnightly - weekly / 2) <= 1, `${fortnightly} is not half of ${weekly}`);
});

test("a plan past its end_date weighs NOTHING — whatever kind it is", () => {
  const over = plan({ end_date: NOW - 86400 });
  assert.equal(monthlyPlannedUAH(over, RATES, NOW), 0);
  // Still counted the day before it ends: the last charge is real money.
  assert.equal(monthlyPlannedUAH(plan({ end_date: NOW + 86400 }), RATES, NOW), 50000);
  // ⚠️ The client's copy tested `kind === "installment"` as well, so a cancelled SUBSCRIPTION
  // with an end date kept its full weight on the Subscriptions page and zero everywhere else.
  // Nothing about the kind enters here, and that is the point.
  assert.equal(monthlyPlannedUAH({ ...over, kind: "subscription" } as never, RATES, NOW), 0);
});

test("the sum is the sum of the parts, in one currency", () => {
  const total = sumMonthlyPlannedUAH([
    plan(),                                                   // 500 ₴
    plan({ period_amount: 500, currency_code: 840 }),         // $5 → 200 ₴
    plan({ end_date: NOW - 1 }),                              // over → 0
  ], RATES, NOW);
  assert.equal(total, 70000);
});

test("nextChargeUnix respects «every N periods»", () => {
  const start = Math.floor(Date.parse("2026-01-10T00:00:00Z") / 1000);
  const monthly = nextChargeUnix(start, "month", 1, NOW);
  const quarterly = nextChargeUnix(start, "month", 3, NOW);
  assert.ok(monthly > NOW && quarterly > NOW);
  // A quarterly plan cannot be due sooner than a monthly one started the same day.
  assert.ok(quarterly >= monthly);
});

test("chargesBetween is a SCHEDULE, not an average — the other half of §SUB-MONTH", () => {
  // The distinction the invariant insists on: «скільки зʼїдають на місяць» is an average, «що
  // спишеться до кінця місяця» is a schedule, and a quarterly plan either falls in the window or
  // does not. A weekly plan falls in it several times.
  const start = Math.floor(Date.parse("2026-05-01T00:00:00Z") / 1000);
  const weekly = { period_amount: 10000, currency_code: 980, period: "week", period_count: 1,
                   start_date: start, end_date: null, title: "w" };
  const from = Math.floor(Date.parse("2026-05-01T00:00:00Z") / 1000);
  const to = Math.floor(Date.parse("2026-05-31T23:59:59Z") / 1000);
  const charges = chargesBetween([weekly as never], RATES, from, to);
  assert.ok(charges.length >= 4, `a weekly plan charges at least 4 times in May, got ${charges.length}`);
  assert.ok(charges.every((c) => c.amount === 10000));
});

/**
 * §SUB-DATE (2026-08-27) — a monthly plan keeps its DAY, whatever the month is worth.
 *
 * `nextChargeUnix` stepped a `Date` with `setMonth(+1)`, and JavaScript resolves 31 February by
 * rolling over into March. A plan anchored on the 31st therefore went 31 Jan → 3 Mar → 3 Apr:
 * February skipped outright, and every later charge on the 3rd — a schedule that silently walks
 * away from the day the person actually pays on, into a different budget month.
 */
test("§SUB-DATE: the 31st clamps to the last day, it does not roll into next month", () => {
  const jan31 = Date.UTC(2026, 0, 31, 10, 0, 0) / 1000;
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

  // Standing on 1 February, the next charge is IN February — not in March.
  assert.equal(day(nextChargeUnix(jan31, "month", 1, Date.UTC(2026, 1, 1) / 1000)), "2026-02-28");
  // And the anchor survives it: March is a 31-day month again.
  assert.equal(day(nextChargeUnix(jan31, "month", 1, Date.UTC(2026, 2, 1) / 1000)), "2026-03-31");
  assert.equal(day(nextChargeUnix(jan31, "month", 1, Date.UTC(2026, 3, 1) / 1000)), "2026-04-30");
});

test("§SUB-DATE: an ordinary day is untouched, years out", () => {
  const start = Date.UTC(2024, 0, 20, 9, 0, 0) / 1000;
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  // The rent case from the feed: paid on the 20th, and still the 20th two years on.
  assert.equal(day(nextChargeUnix(start, "month", 1, Date.UTC(2026, 7, 27) / 1000)), "2026-09-20");
  // A quarterly plan lands on the same day, three months apart.
  assert.equal(day(nextChargeUnix(start, "month", 3, Date.UTC(2026, 7, 27) / 1000)), "2026-10-20");
});

test("§SUB-DATE: a plan whose start is in the future returns that start", () => {
  const start = Date.UTC(2026, 11, 5, 8, 0, 0) / 1000;
  assert.equal(nextChargeUnix(start, "month", 1, Date.UTC(2026, 7, 27) / 1000), start);
});

/**
 * §SUB-ALIAS (2026-08-27) — a subscription is known by more than its title.
 *
 * The report: the plan is «Twitter», the statement says «X Corp.», and the two never met — so the
 * charge got no `planned_id`, its category was guessed, and the feed announced «списань не видно»
 * for a subscription being paid every month. The extra names come from the plan's own note, the
 * field the user already fills in to explain what this is.
 */
test("§SUB-ALIAS: the plan's note supplies the names its title does not", () => {
  const plan = { title: "Twitter", note: "X Corp (твітер) підписка, списується щомісяця" };
  assert.equal(planMatches(plan, "X CORP. PAYMENT"), true, "the billing name, from the note");
  assert.equal(planMatches(plan, "твітер"), true, "and the name the person actually uses");
  assert.equal(planMatches(plan, "TWITTER INC"), true, "the title still works");
  assert.equal(planMatches(plan, "OnTaxi Kyiv"), false);
});

test("§SUB-ALIAS: the words every note contains identify nothing, so they are dropped", () => {
  // Without the stoplist «підписка» would match any statement line carrying the word, and every
  // plan would claim every other plan's charges.
  const plan = { title: "Netflix", note: "підписка, оплата щомісяця, сервіс" };
  assert.deepEqual(planNeedles(plan), ["Netflix"]);
  assert.equal(planMatches(plan, "SPOTIFY підписка"), false);
});

test("§SUB-ALIAS: an empty note changes nothing", () => {
  assert.deepEqual(planNeedles({ title: "Spotify", note: null }), ["Spotify"]);
});
