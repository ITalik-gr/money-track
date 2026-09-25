/**
 * §TAX-* — the ФОП module (docs/TAX.md). Each case is a way to be confidently wrong about tax — the
 * one failure here that costs a penalty. The derived-rate test proves the multipliers against the
 * figures the state published.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb, freezeTime, type MemDb } from "./harness.ts";
import { ratesFor, DEFAULT_PROFILE, type TaxProfile } from "../lib/finance/tax-rates.ts";
import {
  dueDate, accrualsFor, refreshObligations, taxStatus, writeProfile,
} from "../lib/finance/tax.ts";
import * as taxRepo from "../repo/tax.ts";
import { localQuarterStart } from "../lib/finance/time.ts";
import { businessOverview } from "../lib/finance/business.ts";
import { taxBaseUah } from "../lib/finance/nbu.ts";

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
