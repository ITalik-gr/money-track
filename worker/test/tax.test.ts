/**
 * §TAX-* — the ФОП module (docs/TAX.md).
 *
 * The cases here are chosen the way `fixture.ts` chooses its own: each one is a way this module
 * could be confidently wrong, and being confidently wrong about a tax figure is the one failure in
 * this project that costs the user a penalty rather than an evening.
 *
 * The derived-amount test is the load-bearing one. `tax-rates.ts` stores only the minimum wage and
 * the subsistence minimum and derives twelve figures from them; asserting those twelve against the
 * numbers the state actually published is what proves the multipliers, and it is the only check
 * that would catch a mistyped one — a wrong multiplier produces a plausible number, not an error.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, freezeTime, testEnv, type MemDb } from "./harness.ts";
import { ratesFor, basisFor, DEFAULT_PROFILE, type TaxProfile } from "../lib/finance/tax-rates.ts";
import {
  dueDate, quarterLabel, accrualsFor, refreshObligations, taxStatus, writeProfile,
} from "../lib/finance/tax.ts";
import * as taxRepo from "../repo/tax.ts";
import { localQuarterStart, localYmd } from "../lib/finance/time.ts";
import { businessOverview, quietClients, cashGap } from "../lib/finance/business.ts";
import { taxBaseUah } from "../lib/finance/nbu.ts";
import { quarterSummary } from "../lib/finance/tax-report.ts";
import { draftTaxDue } from "../lib/messaging/drafts-fop.ts";
import { renderNotif } from "../../shared/notif-i18n.ts";
import type { Env } from "../env.ts";

/** Kyiv, mid-quarter, mid-month: every period has both elapsed and remaining time. */
const NOW_ISO = "2026-05-14T09:00:00.000Z";
const NOW = Math.floor(Date.parse(NOW_ISO) / 1000);

const G3: TaxProfile = { ...DEFAULT_PROFILE, enabled: true, group: 3 };

function db(): MemDb {
  const d = migratedDb();
  d.raw.prepare(
    "INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_business) VALUES (?,?,?,?,?,?,?)",
  ).run("acc-fop", "fop", "ФОП", 980, 0, 0, 1);
  d.raw.prepare(
    "INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_business) VALUES (?,?,?,?,?,?,?)",
  ).run("acc-personal", "black", "Особистий", 980, 0, 0, 0);
  return d;
}

function income(d: MemDb, row: {
  id: string; account?: string; amount: number; time: number;
  currency?: number; base?: number | null; business?: 0 | 1 | null;
}): void {
  d.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, category_id, merchant, is_business, tax_base_uah)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(row.id, row.account ?? "acc-fop", "mono", row.time, row.amount, row.currency ?? 980,
        16 /* Фріланс — an income category, so INCOME_WHERE accepts it */, "Client",
        row.business ?? null, row.base ?? null);
}

// ─── rates ──────────────────────────────────────────────────────────────────────────────────────

test("2026 figures derive from the minimum wage exactly as published", () => {
  const r = ratesFor({ ...DEFAULT_PROFILE, group: 2 }, "2026-05-14");
  assert.equal(r.basis.min_wage, 864_700, "МЗП 2026 = 8 647 ₴");
  assert.equal(r.esv_monthly, 190_234, "ЄСВ = 22% МЗП = 1 902,34 ₴");
  assert.equal(r.levy_monthly, 86_470, "ВЗ груп 1/2 = 10% МЗП = 864,70 ₴");
  assert.equal(r.single_monthly, 172_940, "ЄП група 2 = 20% МЗП = 1 729,40 ₴");
  assert.equal(r.annual_limit, 721_159_800, "ліміт гр. 2 = 834 МЗП = 7 211 598 ₴");

  const g1 = ratesFor({ ...DEFAULT_PROFILE, group: 1 }, "2026-05-14");
  assert.equal(g1.single_monthly, 33_280, "ЄП група 1 = 10% ПМ = 332,80 ₴");
  assert.equal(g1.annual_limit, 144_404_900, "ліміт гр. 1 = 167 МЗП = 1 444 049 ₴");

  const g3 = ratesFor(G3, "2026-05-14");
  assert.equal(g3.single_income_pct, 5);
  assert.equal(g3.levy_income_pct, 1);
  assert.equal(g3.annual_limit, 1_009_104_900, "ліміт гр. 3 = 1167 МЗП = 10 091 049 ₴");
});

test("a closed period keeps the rates it closed with (§TAX-RATES)", () => {
  // The whole reason the basis carries an effective date: re-reading a 2025 quarter in 2026 must
  // not price it with 2026's minimum wage. Same rule as §BUDGET-MEMORY, with a penalty attached.
  assert.equal(basisFor("2025-12-31").min_wage, 800_000);
  assert.equal(basisFor("2026-01-01").min_wage, 864_700);
  assert.equal(ratesFor({ ...DEFAULT_PROFILE, group: 2 }, "2025-07-01").single_monthly, 160_000);
  assert.equal(ratesFor({ ...DEFAULT_PROFILE, group: 2 }, "2025-07-01").esv_monthly, 176_000);
});

test("a council rate above the legal maximum is a typo, not a higher bill", () => {
  const over = ratesFor({ ...DEFAULT_PROFILE, group: 2, single_override: 500_000 }, "2026-05-14");
  assert.equal(over.single_monthly, 172_940, "clamped to 20% of the minimum wage");
  const under = ratesFor({ ...DEFAULT_PROFILE, group: 2, single_override: 100_000 }, "2026-05-14");
  assert.equal(under.single_monthly, 100_000, "a genuinely lower council rate is kept");
  // Zero is a RATE, not «unset»: some councils set none at all, and `?? maxSingle` must not treat
  // it as missing. The accrual then produces nothing for that kind, and the prune removes the row.
  const zero = ratesFor({ ...DEFAULT_PROFILE, group: 2, single_override: 0 }, "2026-05-14");
  assert.equal(zero.single_monthly, 0, "«the council charges nothing» is an answer, not a gap");
});

test("an ЄСВ exemption zeroes the contribution and nothing else", () => {
  const r = ratesFor({ ...DEFAULT_PROFILE, group: 3, esv_exempt: true }, "2026-05-14");
  assert.equal(r.esv_monthly, 0);
  assert.equal(r.single_income_pct, 5, "the exemption is about ЄСВ alone");
});

// ─── deadlines ──────────────────────────────────────────────────────────────────────────────────

test("group-3 deadlines reproduce the published 2026 calendar (§TAX-DUE)", () => {
  // 40 days to declare + 10 to pay, expressed as «quarter end + 50». These four dates are the
  // check that the arithmetic is the law's and not merely self-consistent.
  assert.equal(dueDate("single_tax", "2025-Q4"), "2026-02-19");
  assert.equal(dueDate("single_tax", "2026-Q1"), "2026-05-20");
  assert.equal(dueDate("single_tax", "2026-Q2"), "2026-08-19");
  assert.equal(dueDate("single_tax", "2026-Q3"), "2026-11-19");
  assert.equal(dueDate("military_levy", "2026-Q1"), "2026-05-20", "ВЗ rides with ЄП for group 3");
});

test("ЄСВ is due on the 19th of the month after the quarter, and groups 1–2 pay in advance", () => {
  assert.equal(dueDate("social_contribution", "2026-Q1"), "2026-04-19");
  assert.equal(dueDate("social_contribution", "2026-Q4"), "2027-01-19", "Q4 crosses the year");
  // Groups 1–2 owe an ADVANCE: the 20th of the month ITSELF, not of the month after. Getting this
  // backwards would show every deadline a month late, which is the direction that costs money.
  assert.equal(dueDate("single_tax", "2026-03"), "2026-03-20");
});

test("quarter labels follow the Kyiv calendar (§APP_TZ)", () => {
  const restore = freezeTime(NOW_ISO);
  try {
    assert.equal(quarterLabel(NOW), "2026-Q2");
    // 31 December 22:30 Kyiv is still Q4 — in UTC it is already the next year, which is exactly
    // the off-by-one §APP_TZ exists to stop.
    assert.equal(quarterLabel(Math.floor(Date.parse("2026-12-31T20:30:00.000Z") / 1000)), "2026-Q4");
  } finally { restore(); }
});

// ─── what counts as business income ─────────────────────────────────────────────────────────────

test("the account answers only for rows that never got their own answer (§TAX-BASE)", async () => {
  const d = db();
  income(d, { id: "a", amount: 10_000_00, time: NOW - 86400 });                       // inherits 1
  income(d, { id: "b", amount: 20_000_00, time: NOW - 86400, business: 0 });          // human said no
  income(d, { id: "c", amount: 30_000_00, time: NOW - 86400, account: "acc-personal" }); // inherits 0
  income(d, { id: "e", amount: 40_000_00, time: NOW - 86400, account: "acc-personal", business: 1 });

  const got = await taxRepo.businessIncome(d, NOW - 86400 * 2, NOW);
  assert.equal(got.base_uah, 10_000_00 + 40_000_00, "inherited yes + explicit yes");
  assert.equal(got.n, 2);
});

test("a foreign receipt without an official rate is REPORTED, never guessed (§TAX-FX)", async () => {
  const d = db();
  income(d, { id: "usd-ok", amount: 1_000_00, time: NOW - 86400, currency: 840, base: 41_000_00 });
  income(d, { id: "usd-no", amount: 2_000_00, time: NOW - 86400, currency: 840, base: null });

  const got = await taxRepo.businessIncome(d, NOW - 86400 * 2, NOW);
  // The un-based receipt contributes NOTHING to the total — and says so. Silently valuing it at
  // its foreign minor units would read as ₴2 000 on a $2 000 invoice: a twentieth of the truth,
  // in the direction that says «you are nowhere near the limit».
  assert.equal(got.base_uah, 41_000_00);
  assert.equal(got.missing_rate, 1, "the screen can say «1 receipt has no rate yet»");
});

// ─── accrual ────────────────────────────────────────────────────────────────────────────────────

test("group 3 accrues 5% + 1% of the quarter's income, plus three months of ЄСВ", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    const qStart = localQuarterStart(NOW);
    income(d, { id: "q1", amount: 100_000_00, time: qStart + 86400 });
    income(d, { id: "q2", amount: 50_000_00, time: qStart + 86400 * 2 });

    const acc = await accrualsFor(d, G3, qStart);
    const by = Object.fromEntries(acc.map((a) => [a.kind, a]));
    assert.equal(by.single_tax.amount, 750_000, "5% of 150 000 ₴");
    assert.equal(by.military_levy.amount, 150_000, "1% of 150 000 ₴");
    assert.equal(by.social_contribution.amount, 190_234 * 3, "ЄСВ is fixed, not a share of income");
    assert.equal(by.single_tax.period, "2026-Q2");
  } finally { restore(); }
});

test("groups 1–2 owe the same fixed amount in a quarter with no income at all", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    const acc = await accrualsFor(d, { ...DEFAULT_PROFILE, enabled: true, group: 2 }, localQuarterStart(NOW));
    const single = acc.filter((a) => a.kind === "single_tax");
    assert.equal(single.length, 3, "one per month of the quarter");
    assert.deepEqual(single.map((a) => a.period), ["2026-04", "2026-05", "2026-06"]);
    assert.ok(single.every((a) => a.amount === 172_940));
    // An app that only reacted to income would report a quiet quarter as owing nothing, which is
    // the most expensive possible wrong answer for a group-2 payer.
  } finally { restore(); }
});

test("a paid obligation is never rewritten by a later accrual (§TAX-DUE)", async () => {
  const d = db();
  // A real operation: `paid_tx_id` is an enforced foreign key, and «paid by a row that does not
  // exist» is not a state the schema allows — which is the point of making it a link.
  income(d, { id: "tx-paid", amount: -500_000, time: NOW });
  await taxRepo.upsertObligation(d, "single_tax", "2026-Q1", 500_000, "2026-05-20");
  const [before] = await taxRepo.listObligations(d, "2026-Q1");
  await taxRepo.markPaid(d, before.id, "tx-paid", NOW);

  await taxRepo.upsertObligation(d, "single_tax", "2026-Q1", 999_999, "2026-05-20");
  const [after] = await taxRepo.listObligations(d, "2026-Q1");
  assert.equal(after.amount, 500_000, "history does not move because a rate table changed");
  assert.equal(after.paid_tx_id, "tx-paid");
});

// ─── the status ─────────────────────────────────────────────────────────────────────────────────

test("the reserve is what is accrued and unpaid, and the next deadline is the nearest one", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    await writeProfile(d, G3);
    income(d, { id: "q1", amount: 100_000_00, time: localQuarterStart(NOW) + 86400 });
    await refreshObligations(d, NOW);

    const st = await taxStatus(d, NOW);
    assert.ok(st.enabled);
    assert.ok(st.reserved > 0, "money on the balance that is not the user's");
    assert.ok(st.next, "there is a next deadline");
    assert.equal(st.quarter.label, "2026-Q2");
    assert.equal(st.quarter.income, 100_000_00);
    // The reserve is the sum of the unpaid rows, not a percentage of anything.
    const unpaid = st.obligations.filter((o) => !o.paid_tx_id).reduce((n, o) => n + o.amount, 0);
    assert.equal(st.reserved, unpaid);
  } finally { restore(); }
});

test("the limit has three states, and a projection outside this year is not a warning", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const quiet = db();
    await writeProfile(quiet, G3);
    income(quiet, { id: "small", amount: 10_000_00, time: NOW - 86400 });
    const a = await taxStatus(quiet, NOW);
    assert.equal(a.limit.state, "ok", "10 000 ₴ in five months reaches no ceiling this year");
    assert.equal(a.limit.projected_date, null);

    const busy = db();
    await writeProfile(busy, G3);
    // ~4.5M ₴ by mid-May is a pace that crosses 10 091 049 ₴ before December.
    income(busy, { id: "big", amount: 4_500_000_00, time: NOW - 86400 });
    const b = await taxStatus(busy, NOW);
    assert.equal(b.limit.state, "projected");
    assert.ok(b.limit.projected_date && b.limit.projected_date < "2027-01-01");

    const over = db();
    await writeProfile(over, G3);
    income(over, { id: "over", amount: 11_000_000_00, time: NOW - 86400 });
    const c = await taxStatus(over, NOW);
    assert.equal(c.limit.state, "exceeded", "already past the ceiling is an event, not a forecast");
  } finally { restore(); }
});

test("a disabled module still answers, so the client renders a card instead of a branch", async () => {
  const d = db();
  const st = await taxStatus(d, NOW);
  assert.equal(st.enabled, false);
  assert.equal(st.reserved, 0);
  assert.deepEqual(st.obligations, []);
  assert.equal(st.next, null);
});

test("changing the group does not leave the previous shape's accruals behind", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    await writeProfile(d, G3);
    income(d, { id: "q1", amount: 100_000_00, time: localQuarterStart(NOW) + 86400 });
    await refreshObligations(d, NOW);

    // The same open quarter, now billed as group 2: fixed monthly ЄП/ВЗ instead of 5% + 1%.
    await writeProfile(d, { ...DEFAULT_PROFILE, enabled: true, group: 2 });
    await refreshObligations(d, NOW);
    const st = await taxStatus(d, NOW);

    const leftovers = st.obligations.filter(
      (o) => o.period.includes("Q") && o.kind !== "social_contribution",
    );
    assert.deepEqual(leftovers, [], "the group-3 quarterly ЄП/ВЗ rows no longer accrue, so they are gone");
    // The reserve is the number this protects: with both shapes stored, one open quarter is billed
    // twice and the user sets aside money the state is not going to ask for.
    const expected = st.obligations.filter((o) => !o.paid_tx_id).reduce((n, o) => n + o.amount, 0);
    assert.equal(st.reserved, expected);
  } finally { restore(); }
});

test("refreshing twice changes nothing, and never revives a paid quarter", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    await writeProfile(d, G3);
    income(d, { id: "q1", amount: 100_000_00, time: localQuarterStart(NOW) + 86400 });
    income(d, { id: "tx-paid", amount: -500_000, time: NOW });

    await refreshObligations(d, NOW);
    const first = await taxRepo.listObligations(d, "2025-01");
    const esv = first.find((o) => o.kind === "social_contribution")!;
    await taxRepo.markPaid(d, esv.id, "tx-paid", NOW);

    // Three more refreshes: the prune added in the fix above deletes, so «idempotent» stopped
    // being free — a scope that was one period too wide would show up here as a row that keeps
    // disappearing and coming back with a new id.
    for (let i = 0; i < 3; i++) await refreshObligations(d, NOW);
    const again = await taxRepo.listObligations(d, "2025-01");

    assert.deepEqual(
      again.map((o) => [o.id, o.kind, o.period, o.amount, o.due_date]),
      first.map((o) => [o.id, o.kind, o.period, o.amount, o.due_date]),
      "same rows, same ids, same amounts",
    );
    const stillPaid = again.find((o) => o.id === esv.id)!;
    assert.equal(stillPaid.paid_tx_id, "tx-paid", "a paid obligation is not pruned either");
  } finally { restore(); }
});

test("an exemption switched on removes the accrual instead of leaving the last one", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    await writeProfile(d, G3);
    await refreshObligations(d, NOW);
    assert.ok(
      (await taxRepo.listObligations(d, "2026-Q1")).some((o) => o.kind === "social_contribution"),
      "ЄСВ accrues while it is owed",
    );

    // `accrualsFor` drops a zero amount, so before the prune this branch left the last non-zero
    // ЄСВ standing in the reserve — money set aside against a liability the user had just told
    // the app was not theirs.
    await writeProfile(d, { ...G3, esv_exempt: true });
    await refreshObligations(d, NOW);
    const st = await taxStatus(d, NOW);
    assert.equal(st.obligations.filter((o) => o.kind === "social_contribution").length, 0);
  } finally { restore(); }
});

test("the tax YEAR turns over in Kyiv, not in UTC (§APP_TZ · §TAX-LIMIT)", async () => {
  // The limit counts the calendar TAX year, and both sides of that boundary exist in production:
  // 31 December 22:30 Kyiv is already 1 January in UTC. A year that turned over in UTC would empty
  // the counter two hours early — «you have the whole limit again» on the evening of the 31st.
  const d = db();
  await writeProfile(d, G3);
  income(d, { id: "march", amount: 1_000_000_00, time: Math.floor(Date.parse("2026-03-10T10:00:00.000Z") / 1000) });

  const lastMinute = Math.floor(Date.parse("2026-12-31T20:30:00.000Z") / 1000); // 22:30 Kyiv, still 2026
  const restoreOld = freezeTime("2026-12-31T20:30:00.000Z");
  try {
    const st = await taxStatus(d, lastMinute);
    assert.equal(st.limit.used, 1_000_000_00, "the year is not over yet in Kyiv");
    assert.equal(st.quarter.label, "2026-Q4");
  } finally { restoreOld(); }

  const justAfter = Math.floor(Date.parse("2026-12-31T22:30:00.000Z") / 1000); // 00:30 Kyiv, now 2027
  const restoreNew = freezeTime("2026-12-31T22:30:00.000Z");
  try {
    const st = await taxStatus(d, justAfter);
    assert.equal(st.limit.used, 0, "a new tax year starts at Kyiv midnight, with an empty counter");
    assert.equal(st.quarter.label, "2027-Q1");
  } finally { restoreNew(); }
});

test("the quarter's income is ONE figure in the status, the overview and the ledger", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    await writeProfile(d, G3);
    const qStart = localQuarterStart(NOW);
    const qEnd = localQuarterStart(NOW, 1);
    income(d, { id: "uah", amount: 60_000_00, time: qStart + 86400 });
    income(d, { id: "usd", amount: 1_000_00, time: qStart + 86400 * 2, currency: 840, base: 41_000_00 });
    income(d, { id: "usd-norate", amount: 2_000_00, time: qStart + 86400 * 3, currency: 840, base: null });
    income(d, { id: "personal", amount: 99_000_00, time: qStart + 86400 * 4, account: "acc-personal" });

    const status = await taxStatus(d, NOW);
    const overview = await businessOverview(d, NOW, 1);
    const rows = await taxRepo.incomeLedger(d, qStart, qEnd, NOW);
    // The same expression the CSV and the JSON ledger both total with: an unresolved base is worth
    // nothing, never its foreign minor units (§TAX-FX).
    const ledgerTotal = rows.reduce((n, r) => n + (r.currency_code === 980 ? r.amount : r.tax_base_uah ?? 0), 0);

    assert.equal(status.quarter.income, 60_000_00 + 41_000_00, "the personal receipt is not business income");
    assert.equal(overview.quarters.at(-1)!.income, status.quarter.income, "the overview agrees");
    assert.equal(ledgerTotal, status.quarter.income, "the book of income agrees");
    assert.deepEqual(rows.map((r) => r.id), ["uah", "usd", "usd-norate"], "and it is the same population");
    assert.equal(status.quarter.missing_rate, 1, "with the un-based receipt still declared aloud");
  } finally { restore(); }
});

test("the clients on the business card add up to the quarter printed above them", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    await writeProfile(d, G3);
    const qStart = localQuarterStart(NOW);
    income(d, { id: "a1", amount: 30_000_00, time: qStart + 86400 });
    income(d, { id: "a2", amount: 20_000_00, time: NOW - 86400 });
    // Dated AHEAD of today, inside the same quarter: `createCashTx` takes whatever `time` it is
    // given, so this is a row a mistyped year or a deliberate advance entry really produces.
    income(d, { id: "later", amount: 10_000_00, time: NOW + 86400 * 3 });

    const overview = await businessOverview(d, NOW, 1);
    const quarter = overview.quarters.at(-1)!.income;
    const parties = overview.counterparties.reduce((n, c) => n + c.total_uah, 0);
    assert.equal(quarter, 60_000_00, "the quarter is the quarter, future-dated row included");
    assert.equal(parties, quarter, "and the clients are read over the SAME window");
    assert.equal(overview.top_share_pct, 100, "one merchant, so the concentration is the whole of it");
  } finally { restore(); }
});

test("the previous year's Q4 deadlines reach the feed — they are the year's biggest", async () => {
  const restore = freezeTime("2026-02-10T09:00:00.000Z");
  try {
    const d = db();
    await writeProfile(d, G3);
    income(d, { id: "dec", amount: 100_000_00, time: Math.floor(Date.parse("2025-12-10T10:00:00.000Z") / 1000) });
    const at = Math.floor(Date.parse("2026-02-10T09:00:00.000Z") / 1000);

    const drafts = await draftTaxDue(testEnv(d) as unknown as Env, at);
    const keys = drafts.map((x) => x.dedup_key);
    // 19 February is the ЄП/ВЗ deadline for the PREVIOUS year's Q4 — the one payment a person is
    // most likely to forget, because the quarter it belongs to is already closed and filed away.
    assert.ok(keys.some((k) => k.includes("single_tax:2025-Q4")), `ЄП for 2025-Q4 missing: ${keys.join(", ")}`);
    assert.ok(keys.some((k) => k.includes("military_levy:2025-Q4")), "ВЗ rides with it");
    // And ЄСВ for the same quarter was due on 19 January, so on 10 February it is OVERDUE — the
    // single most useful sentence this feed can produce.
    assert.ok(
      keys.some((k) => k.includes("social_contribution:2025-Q4:overdue")),
      `the overdue ЄСВ is missing: ${keys.join(", ")}`,
    );
  } finally { restore(); }
});

test("a SPLIT business expense is counted once, not once per part (§SPLIT)", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    const qStart = localQuarterStart(NOW);
    const at = qStart + 86400;
    d.raw.prepare(
      `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, category_id, merchant)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("work-spend", "acc-fop", "mono", at, -60_000_00, 980, 8, "Epicentr");
    // Two parts of one purchase — the shape that makes STATS_JOINS return two rows for one id.
    for (const [cat, amount] of [[8, -40_000_00], [9, -20_000_00]] as const) {
      d.raw.prepare("INSERT INTO tx_splits (tx_id, category_id, amount, created_at) VALUES (?,?,?,?)")
        .run("work-spend", cat, amount, at);
    }

    const spend = await taxRepo.businessExpenses(d, qStart, localQuarterStart(NOW, 1));
    // The reason `repo/tax.ts` reuses the canon through `IN (SELECT …)` instead of repeating the
    // joins, and the property the windowed subquery had to preserve: a SUM over the multiplied
    // rows would report 120 000 ₴ of work costs on a 60 000 ₴ purchase.
    assert.equal(spend.uah, 60_000_00, "one purchase, one amount");
    assert.equal(spend.n, 1);
  } finally { restore(); }
});

test("the quarter's outlook projects from a real window, never from a single day", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    await writeProfile(d, G3);
    const qStart = localQuarterStart(NOW);
    income(d, { id: "q", amount: 100_000_00, time: qStart + 86400 });

    const o = (await businessOverview(d, NOW, 1)).outlook;
    assert.equal(o.label, "2026-Q2");
    assert.equal(o.income_so_far, 100_000_00);
    // 43 days elapsed of a 91-day quarter: the pace is meaningful, so the projection exists.
    assert.equal(o.days_elapsed, 43);
    assert.equal(o.days_left, 91 - 43);
    assert.equal(o.projected_income, Math.round((100_000_00 / 43) * 91));
    assert.ok(o.projected_income! > o.income_so_far, "and it looks forward, not backward");
    assert.equal(o.accrued_now, 500_000 + 100_000 + 190_234 * 3, "5% + 1% of the 100 000 ₴ that ARRIVED, plus ЄСВ");

    // Two days into the quarter the same income is not a pace. A forecast built from one invoice
    // on the 2nd reads as a confident statement about three months (§CADENCE).
    const early = Math.floor(Date.parse("2026-04-03T09:00:00.000Z") / 1000);
    const restoreEarly = freezeTime("2026-04-03T09:00:00.000Z");
    try {
      const e = (await businessOverview(d, early, 1)).outlook;
      assert.equal(e.projected_income, null, "too early to say");
      assert.equal(e.projected_tax, null);
      assert.ok(e.income_so_far > 0, "but what already arrived is still stated");
    } finally { restoreEarly(); }
  } finally { restore(); }
});

test("every group is priced on the SAME income, and against its own ceiling (§TAX-LIMIT)", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    await writeProfile(d, G3);
    // Past group 1's annual ceiling (1 444 049 ₴) and well under group 2's.
    income(d, { id: "big", amount: 2_000_000_00, time: localQuarterStart(NOW) + 86400 });

    const groups = (await businessOverview(d, NOW, 1)).outlook.groups;
    const by = Object.fromEntries(groups.map((g) => [g.group, g]));
    // Groups 1–2 are FIXED: three months of the monthly ЄП + ВЗ, whatever came in.
    assert.equal(by[1]!.tax, (33_280 + 86_470) * 3);
    assert.equal(by[2]!.tax, (172_940 + 86_470) * 3);
    assert.equal(by[1]!.esv, 190_234 * 3, "ЄСВ is the same in every group");
    assert.equal(by[1]!.total, by[1]!.tax + by[1]!.esv);
    // Group 3 is a share of the projected income, so it is the only one that moves with the base.
    assert.ok(by[3]!.tax > by[2]!.tax, "at this income the percentage group costs more");
    // ⚠️ And the cheap answer is not available: past its ceiling, group 1 is not a choice.
    assert.equal(by[1]!.over_limit, true, "1 444 049 ₴ is behind us");
    assert.equal(by[2]!.over_limit, false);
    assert.equal(by[1]!.annual_limit, 144_404_900);
  } finally { restore(); }
});

test("ЄСВ in a quarter with NO income gets its own sentence, not a smaller number", async () => {
  const restore = freezeTime("2026-04-10T09:00:00.000Z");
  try {
    const d = db();
    await writeProfile(d, G3);
    const at = Math.floor(Date.parse("2026-04-10T09:00:00.000Z") / 1000);
    // Q1 2026 had no business income at all, and ЄСВ for it is due on 19 April.
    const drafts = await draftTaxDue(testEnv(d) as unknown as Env, at);
    const esv = drafts.find((x) => x.dedup_key.includes("social_contribution:2026-Q1"))!;
    assert.ok(esv, `ЄСВ for the quiet quarter is missing: ${drafts.map((x) => x.dedup_key).join(", ")}`);
    assert.equal(esv.tkey, "deadline_tax_quiet",
      "«I earned nothing so I owe nothing» is true of the single tax and false of the contribution");

    const rendered = renderNotif("uk", esv.tkey!, esv.tparams!);
    assert.match(rendered.title, /навіть без доходу/);
    assert.match(String(rendered.body), /фіксований у всіх групах/);

    // With income in the same quarter it is the ordinary line again — the quiet sentence is about
    // a quarter that was quiet, not about ЄСВ in general.
    const d2 = db();
    await writeProfile(d2, G3);
    income(d2, { id: "q1", amount: 50_000_00, time: Math.floor(Date.parse("2026-02-10T10:00:00.000Z") / 1000) });
    const busy = await draftTaxDue(testEnv(d2) as unknown as Env, at);
    assert.equal(
      busy.find((x) => x.dedup_key.includes("social_contribution:2026-Q1"))!.tkey, "deadline_tax",
    );
  } finally { restore(); }
});

test("work costs roll up to the category ROOT, and foreign ones stay out", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    const at = localQuarterStart(NOW) + 86400;
    // 35 «Таксі» is a CHILD of 3 «Транспорт»; it must be reported under its parent like every
    // other breakdown in this project, or the list would disagree with the total above it.
    // (43 «Софт і хмара» would NOT do here: migration 0047 made it top-level, so it is its own
    // root — the same fact the eval dataset had to learn.)
    expense(d, { id: "taxi", amount: -30_000_00, time: at, category: 35 });
    expense(d, { id: "taxi2", amount: -10_000_00, time: at, category: 35 });
    expense(d, { id: "home", amount: -50_000_00, time: at, category: 8 });
    expense(d, { id: "usd-tool", amount: -20_000_00, time: at, category: 43, currency: 840 });

    const rows = await taxRepo.businessExpensesByCategory(d, localQuarterStart(NOW), localQuarterStart(NOW, 1), "uk");
    const total = await taxRepo.businessExpenses(d, localQuarterStart(NOW), localQuarterStart(NOW, 1));
    assert.deepEqual(rows.map((r) => [r.category_id, r.uah, r.n]), [[8, 50_000_00, 1], [3, 40_000_00, 2]]);
    assert.equal(rows.reduce((n, r) => n + r.uah, 0), total.uah,
      "the breakdown adds up to the figure printed above it — same population, same rule");
    assert.equal(total.foreign_n, 1, "and the currency row is counted, not valued");
  } finally { restore(); }
});

test("a client who stopped paying is judged by their OWN rhythm (§RHYTHM)", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    await writeProfile(d, G3);
    const DAY = 86_400;
    // Monthly client, last paid 80 days ago: late by any reading.
    for (const k of [5, 4, 3]) income(d, { id: `m${k}`, amount: 50_000_00, time: NOW - (80 + 30 * (k - 3)) * DAY, });
    d.raw.prepare("UPDATE transactions SET merchant = ? WHERE id IN ('m5','m4','m3')").run("Monthly Ltd");
    // Twice-a-year client, last paid 120 days ago: NOT late — a fixed 90-day rule would announce
    // this one every single year while missing the monthly client for a month.
    for (const k of [3, 2, 1]) income(d, { id: `h${k}`, amount: 300_000_00, time: NOW - (120 + 182 * (k - 1)) * DAY });
    d.raw.prepare("UPDATE transactions SET merchant = ? WHERE id IN ('h3','h2','h1')").run("Halfyear Co");
    // Two payments only: one interval is a coincidence, not a rhythm.
    for (const k of [2, 1] as const) income(d, { id: `t${k}`, amount: 10_000_00, time: NOW - (200 + 30 * k) * DAY });
    d.raw.prepare("UPDATE transactions SET merchant = ? WHERE id IN ('t2','t1')").run("Twice Only");

    const quiet = await quietClients(d, NOW);
    assert.deepEqual(quiet.map((q) => q.name), ["Monthly Ltd"]);
    assert.equal(quiet[0]!.median_gap_days, 30);
    assert.equal(quiet[0]!.days_since_last, 80);
    assert.equal(quiet[0]!.n, 3);
  } finally { restore(); }
});

test("the cash gap is named only when BOTH the deadline and the rhythm are real", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    await writeProfile(d, G3);
    const DAY = 86_400;
    // Paid monthly, last receipt 25 days ago → the next one is expected in ~5 days.
    for (const k of [3, 2, 1]) income(d, { id: `r${k}`, amount: 40_000_00, time: NOW - (25 + 30 * (k - 1)) * DAY });

    // A deadline BEFORE that: due tomorrow, money expected in five days.
    const tomorrow = localYmd(NOW + DAY);
    const gap = await cashGap(d, NOW, { due_date: tomorrow, amount: 500_000 });
    assert.ok(gap, "the tax falls due before the receipt that pays it");
    assert.equal(gap!.days_short, 4);
    assert.equal(gap!.expected_income, localYmd(NOW + 5 * DAY));

    // A deadline AFTER the expected receipt is not a gap — the money arrives first.
    assert.equal(await cashGap(d, NOW, { due_date: localYmd(NOW + 40 * DAY), amount: 500_000 }), null);
    // And no obligation at all is not a gap either.
    assert.equal(await cashGap(d, NOW, null), null);

    // Nor is it named without a rhythm: one receipt gives no gap to project from (§RHYTHM).
    const thin = db();
    income(thin, { id: "only", amount: 40_000_00, time: NOW - 25 * DAY });
    assert.equal(await cashGap(thin, NOW, { due_date: tomorrow, amount: 500_000 }), null);
  } finally { restore(); }
});

test("a group-2 quarter sums its THREE MONTHLY accruals, not an empty quarterly row", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    // Groups 1–2 accrue per MONTH (`2026-04`…), and only ЄСВ is filed under `2026-Q2`. A summary
    // that read the quarter label alone would report the single tax and the levy as zero — for
    // the group that pays them whether or not anything came in, which is the whole reason the
    // module treats a quiet quarter as a liability.
    await writeProfile(d, { ...DEFAULT_PROFILE, enabled: true, group: 2 });
    await refreshObligations(d, NOW);

    const q2 = (await quarterSummary(d, 2026)).find((r) => r.quarter === "2026-Q2")!;
    assert.equal(q2.single_tax, 172_940 * 3, "three months of ЄП, folded into the quarter");
    assert.equal(q2.military_levy, 86_470 * 3, "and three of ВЗ");
    assert.equal(q2.social_contribution, 190_234 * 3, "ЄСВ is quarterly in every group");
    assert.equal(q2.income, 0, "with no income at all — which is exactly when this matters");
    assert.equal(q2.outstanding, q2.single_tax + q2.military_levy + q2.social_contribution);
  } finally { restore(); }
});

// ─── §TAX-DUE: «paid» is a link ─────────────────────────────────────────────────────────────────

function expense(d: MemDb, row: {
  id: string; amount: number; time: number; category?: number | null; currency?: number; merchant?: string;
}): void {
  d.raw.prepare(
    `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, category_id, merchant)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(row.id, "acc-fop", "mono", row.time, row.amount, row.currency ?? 980,
        row.category === undefined ? 25 : row.category, row.merchant ?? "ДПС");
}

test("the operation that paid an obligation is PROPOSED, never assumed (§TAX-DUE)", async () => {
  const d = db();
  const due = "2026-05-20";
  const dueUnix = Math.floor(Date.parse(`${due}T00:00:00Z`) / 1000);
  await taxRepo.upsertObligation(d, "single_tax", "2026-Q1", 500_000, due);
  const [o] = await taxRepo.listObligations(d, "2026-Q1");

  expense(d, { id: "exact", amount: -500_000, time: dueUnix - 2 * 86400 });
  expense(d, { id: "close", amount: -495_000, time: dueUnix - 5 * 86400 });
  expense(d, { id: "uncategorised", amount: -500_000, time: dueUnix - 30 * 86400, category: null });
  expense(d, { id: "groceries", amount: -500_000, time: dueUnix - 1 * 86400, category: 1 });
  expense(d, { id: "usd", amount: -500_000, time: dueUnix, currency: 840 });
  expense(d, { id: "far", amount: -500_000, time: dueUnix - 200 * 86400 });
  expense(d, { id: "wrong-size", amount: -900_000, time: dueUnix });
  // Already the answer to another obligation: one payment must not settle two quarters.
  await taxRepo.upsertObligation(d, "military_levy", "2026-Q1", 500_000, due);
  const levy = (await taxRepo.listObligations(d, "2026-Q1")).find((x) => x.kind === "military_levy")!;
  expense(d, { id: "taken", amount: -500_000, time: dueUnix });
  await taxRepo.markPaid(d, levy.id, "taken", dueUnix);

  const got = await taxRepo.paymentCandidates(d, o.amount, o.due_date);
  assert.deepEqual(got.map((c) => c.id), ["exact", "uncategorised", "close"],
    "the nearest amount first, then the nearest date; no groceries, no dollars, nothing already linked");
});

test("linking the payment settles the obligation and drops it out of the reserve", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    await writeProfile(d, G3);
    income(d, { id: "q", amount: 100_000_00, time: localQuarterStart(NOW) + 86400 });
    await refreshObligations(d, NOW);
    const before = await taxStatus(d, NOW);
    const target = before.next!;
    expense(d, { id: "paid-it", amount: -target.amount, time: NOW });

    assert.equal(await taxRepo.markPaid(d, target.id, "paid-it", NOW), true);
    const after = await taxStatus(d, NOW);
    assert.equal(after.reserved, before.reserved - target.amount, "the reserve is what is STILL owed");
    assert.equal(after.obligations.find((o) => o.id === target.id)!.paid_tx_id, "paid-it");
    // And the accrual for a paid period is never rewritten afterwards (§TAX-DUE, §BUDGET-MEMORY).
    await refreshObligations(d, NOW);
    assert.equal(
      (await taxStatus(d, NOW)).obligations.find((o) => o.id === target.id)!.paid_tx_id, "paid-it",
    );
  } finally { restore(); }
});

test("the quarter summary is read from what was FILED, not recomputed (§TAX-DUE)", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    await writeProfile(d, G3);
    income(d, { id: "q2", amount: 200_000_00, time: localQuarterStart(NOW) + 86400 });
    await refreshObligations(d, NOW);
    // Settle Q2's own ЄП, deliberately NOT `status.next` — the nearest deadline here belongs to
    // 2025-Q4 (its ЄСВ was due on 19 January), and a summary of 2026 must not count it.
    const target = (await taxRepo.listObligations(d, "2026-Q2"))
      .find((o) => o.period === "2026-Q2" && o.kind === "single_tax")!;
    expense(d, { id: "pay", amount: -target.amount, time: NOW });
    await taxRepo.markPaid(d, target.id, "pay", NOW);

    const rows = await quarterSummary(d, 2026);
    assert.equal(rows.length, 4, "every quarter of the year is present, including the empty ones");
    const q2 = rows.find((r) => r.quarter === "2026-Q2")!;
    assert.equal(q2.income, 200_000_00);
    assert.equal(q2.receipts, 1);
    assert.equal(q2.single_tax, 1_000_000, "5% of 200 000 ₴");
    assert.equal(q2.military_levy, 200_000, "1%");
    assert.equal(q2.social_contribution, 190_234 * 3);
    assert.equal(q2.paid, target.amount, "and only that one");
    assert.equal(q2.outstanding, q2.single_tax + q2.military_levy + q2.social_contribution - q2.paid);
    // An empty quarter reads as zeros, not as an absent row: an accountant cannot tell «no data»
    // apart from «nobody looked».
    const q4 = rows.find((r) => r.quarter === "2026-Q4")!;
    assert.equal(q4.income, 0);
    assert.equal(q4.receipts, 0);
  } finally { restore(); }
});

// ─── §TAX-FX: the official rate on a date ───────────────────────────────────────────────────────

/** Swap `fetch` for the duration of one case, the way `ai-stream.test.ts` and `catchup.test.ts` do. */
async function withFetch<T>(f: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try { return await run(); } finally { globalThis.fetch = real; }
}

/** The NBU's own shape: an array, empty on a day it published nothing, dates as DD.MM.YYYY. */
function nbuStub(published: Record<string, number>): { fetch: typeof globalThis.fetch; asked: string[] } {
  const asked: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const date = new URL(String(input)).searchParams.get("date")!;
    asked.push(date);
    const rate = published[date];
    const ymd = `${date.slice(6, 8)}.${date.slice(4, 6)}.${date.slice(0, 4)}`;
    return new Response(JSON.stringify(rate ? [{ rate, cc: "USD", exchangedate: ymd }] : []), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

test("a receipt that lands on a weekend is valued at the last published rate (§TAX-FX)", async () => {
  // Saturday 16 May 2026. The NBU publishes nothing for a non-working day, and «no rate» is the
  // normal case rather than an edge one — money arrives on Saturdays all the time.
  const d = db();
  const saturday = Math.floor(Date.parse("2026-05-16T09:00:00.000Z") / 1000);
  const stub = nbuStub({ "20260515": 41.5 });

  const base = await withFetch(stub.fetch, () => taxBaseUah(d, 1_000_00, 840, saturday));
  assert.equal(base, 41_500_00, "$1 000 at Friday's 41,50 ₴");
  assert.deepEqual(stub.asked, ["20260516", "20260515"], "asked for the day, then walked back one");

  const stored = await d.prepare(
    "SELECT fetched_for, effective_date, rate FROM nbu_rates WHERE currency_code = 840",
  ).first<{ fetched_for: string; effective_date: string; rate: number }>();
  // BOTH dates are recorded: the date asked for is the cache key, the date the rate is actually
  // FOR is what the ledger prints. Storing one of them would leave the next reader to re-derive
  // the fallback, differently.
  assert.equal(stored!.fetched_for, "2026-05-16");
  assert.equal(stored!.effective_date, "2026-05-15", "normalised out of the NBU's DD.MM.YYYY");

  const again = nbuStub({});
  const cached = await withFetch(again.fetch, () => taxBaseUah(d, 1_000_00, 840, saturday));
  assert.equal(cached, 41_500_00, "cached forever: an official rate for a past date cannot change");
  assert.deepEqual(again.asked, [], "and no second request went out");
});

test("the New Year run of holidays is walked back through, not given up on", async () => {
  const d = db();
  const jan1 = Math.floor(Date.parse("2027-01-01T09:00:00.000Z") / 1000);
  // Nothing published 1 January, and 2 and 3 January 2027 are a weekend: the last rate is the
  // 31st's, three days back. The walk goes four days for exactly this case.
  const stub = nbuStub({ "20261231": 42.0 });
  const base = await withFetch(stub.fetch, () => taxBaseUah(d, 500_00, 840, jan1));
  assert.equal(base, 21_000_00);
  assert.deepEqual(stub.asked, ["20270101", "20261231"]);
});

test("a rate that cannot be fetched leaves the receipt WITHOUT a base, never with a guess", async () => {
  const d = db();
  const t = Math.floor(Date.parse("2026-05-14T09:00:00.000Z") / 1000);

  const silent = await withFetch(nbuStub({}).fetch, () => taxBaseUah(d, 1_000_00, 840, t));
  assert.equal(silent, null, "five days of nothing published is «unknown», not zero and not 1:1");

  const offline = (async () => { throw new Error("network"); }) as typeof globalThis.fetch;
  assert.equal(await withFetch(offline, () => taxBaseUah(d, 1_000_00, 840, t)), null);

  const rows = await d.prepare("SELECT COUNT(*) AS n FROM nbu_rates").first<{ n: number }>();
  assert.equal(rows!.n, 0, "and nothing was cached, so tomorrow's retry is free to succeed");
});

test("hryvnia needs no rate, no request and no stored copy of a number we already have", async () => {
  const d = db();
  const boom = (async () => { throw new Error("must not be called"); }) as typeof globalThis.fetch;
  const t = Math.floor(Date.parse("2026-05-14T09:00:00.000Z") / 1000);
  assert.equal(await withFetch(boom, () => taxBaseUah(d, 7_777_00, 980, t)), 7_777_00);
  // Which is why `tax_base_uah` is NULL on most rows rather than a duplicate of `amount`.
  assert.equal((await d.prepare("SELECT COUNT(*) AS n FROM nbu_rates").first<{ n: number }>())!.n, 0);
});

// ─── the tails ──────────────────────────────────────────────────────────────────────────────────

test("the adviser is told the reserve is ALREADY inside own funds", async () => {
  const restore = freezeTime(NOW_ISO);
  try {
    const d = db();
    await writeProfile(d, G3);
    income(d, { id: "q", amount: 100_000_00, time: localQuarterStart(NOW) + 86400 });
    await refreshObligations(d, NOW);

    const { taxContext } = await import("../lib/finance/tax.ts");
    const ctx = await taxContext(d, NOW);
    const fop = ctx.fop as { tax_reserved_uah: number };
    assert.ok(fop.tax_reserved_uah > 0);
    // The note is the load-bearing part. A model handed `tax_reserved_uah` beside `own_funds_uah`
    // will subtract one from the other and call the result the cushion — the names invite it.
    assert.match(String(ctx.fop_note), /ALREADY counted inside own_funds_uah/);
    assert.match(String(ctx.fop_note), /never subtract it/);
  } finally { restore(); }
});

test("a disabled module contributes NOTHING to the snapshot, not zeroes", async () => {
  const { taxContext } = await import("../lib/finance/tax.ts");
  // Zeroes would read as «this user is a ФОП who owes nothing», which is a claim about somebody's
  // taxes that nobody made. An absent key reads as «not applicable», which is the truth.
  assert.deepEqual(await taxContext(db(), NOW), {});
});
