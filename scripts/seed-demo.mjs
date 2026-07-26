// Demo dataset generator (P4.1, PLATFORM.md §11).
//
// Produces a deterministic, realistic ~6-month financial history so that EVERY screen of the
// portfolio demo has something meaningful on it — no empty state, no NaN, no zero. The output is
// a plain JSON snapshot (`worker/demo/dataset.json`) that the ephemeral demo Durable Object
// (P4.2) replays with INSERT after running the normal migrations (which already seed the category
// taxonomy 1–47 and MCC rules).
//
// TIME CONTRACT (read before touching P4.2):
//   All timestamps are ABSOLUTE unix seconds anchored at `meta.anchor` (a fixed generation date,
//   so regenerating gives a byte-identical file and clean git diffs). The loader MUST rebase:
//   shift every field listed in `meta.timeFields` by (nowAtLoad - meta.anchor) so the newest
//   transaction is always ~today and the 6-month sparklines/trends stay populated forever.
//   `health_history.day` is derived from `ts` — after shifting `ts`, recompute `day` from it.
//
// Determinism: a seeded PRNG (mulberry32). No Date.now(), no Math.random() — same output always.
//
// Regenerate:  node scripts/seed-demo.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "demo", "dataset.json");

// Fixed anchor so the committed JSON is stable. July 25 2026, 12:00 UTC.
const ANCHOR = Math.floor(Date.UTC(2026, 6, 25, 12, 0, 0) / 1000);
const DAY = 86400;

// Seeded PRNG — deterministic across runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260725);
const randInt = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

// n days before the anchor, at a given hour (local-ish; exact minute irrelevant for stats).
const daysAgo = (n, hour = 12) => ANCHOR - n * DAY + (hour - 12) * 3600;
// Timestamp for the `d`-th of the month, `m` whole months before the anchor month.
function monthDay(m, d, hour = 12) {
  const base = new Date(ANCHOR * 1000);
  const dt = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - m, d, hour, 0, 0));
  return Math.floor(dt.getTime() / 1000);
}

// ---- accounts ----------------------------------------------------------------
// Balances in minor units of the account currency. Own funds = balance − credit_limit (the
// black card carries a limit that is NOT the user's money); role drives cushion vs investment.
const accounts = [
  { id: "acc-white", type: "white", title: "Mono White", currency_code: 980, balance: 15_000_00, credit_limit: 0, is_manual: 0, is_active: 1, role: "liquid", ai_note: "Main everyday debit card, salary lands here.", provider: "mono" },
  { id: "acc-black", type: "black", title: "Mono Black", currency_code: 980, balance: 3_800_00, credit_limit: 5_000_00, is_manual: 0, is_active: 1, role: "liquid", ai_note: "Credit card; try to keep the balance paid off.", provider: "mono", statement_day: 5, payment_day: 20, min_payment: 1_200_0 },
  { id: "acc-cash", type: "cash", title: "Cash", currency_code: 980, balance: 8_000_00, credit_limit: 0, is_manual: 1, is_active: 1, role: "liquid", ai_note: null, provider: "manual" },
  { id: "acc-jar", type: "jar", title: "Emergency jar", currency_code: 980, balance: 65_000_00, credit_limit: 0, is_manual: 0, is_active: 1, role: "liquid", ai_note: "Rainy-day fund, 3-month cushion target.", provider: "mono" },
  { id: "acc-usd", type: "manual_card", title: "USD card", currency_code: 840, balance: 3_200_00, credit_limit: 0, is_manual: 1, is_active: 1, role: "liquid", ai_note: "Holds freelance income in USD.", provider: "manual" },
  { id: "acc-eur", type: "manual_card", title: "EUR card", currency_code: 978, balance: 550_00, credit_limit: 0, is_manual: 1, is_active: 1, role: "liquid", ai_note: "For travel inside the EU.", provider: "manual" },
  { id: "acc-crypto", type: "crypto", title: "Crypto (BTC/ETH)", currency_code: 840, balance: 2_100_00, credit_limit: 0, is_manual: 1, is_active: 1, role: "investment", ai_note: "Long-term crypto, do not touch unless critical.", provider: "manual" },
  { id: "acc-broker", type: "manual_card", title: "Brokerage", currency_code: 840, balance: 4_500_00, credit_limit: 0, is_manual: 1, is_active: 1, role: "investment", ai_note: "Index funds, long horizon.", provider: "manual" },
];
for (const a of accounts) a.updated_at = ANCHOR;

// FX rates: ₴ per 1 whole unit (980 is hardcoded to 1 in canon, so only foreign codes needed).
const RATES = { "840": 41.5, "978": 45.0 };

// ---- transaction plumbing ----------------------------------------------------
const txs = [];
const splits = [];
const reimb = [];
let seq = 0;
const nextId = () => `d-${String(++seq).padStart(4, "0")}`;

// Push a transaction. `amount` is minor units in the account currency (negative = expense).
function tx(o) {
  const acc = accounts.find((a) => a.id === o.account_id);
  const source = acc.type === "cash" ? "cash" : acc.is_manual ? "manual" : "mono";
  txs.push({
    id: o.id ?? nextId(),
    account_id: o.account_id,
    source,
    time: o.time,
    amount: o.amount,
    currency_code: acc.currency_code,
    mcc: o.mcc ?? null,
    category_id: o.category_id ?? null,
    merchant: o.merchant ?? null,
    comment: o.comment ?? null,
    user_note: o.user_note ?? null,
    balance_after: null,
    cashback: o.cashback ?? null,
    hold: 0,
    planned_id: o.planned_id ?? null,
    receipt_id: o.receipt_id ?? null,
    is_transfer: o.is_transfer ?? 0,
    ai_enriched: o.ai_enriched ?? 1,
    event_id: o.event_id ?? null,
    real_category_id: o.real_category_id ?? null,
    original_amount: o.original_amount ?? null,
    original_currency: o.original_currency ?? null,
    ai_note: o.ai_note ?? null,
    transfer_pair_id: o.transfer_pair_id ?? null,
    importance: o.importance ?? null,
    name_locked: o.name_locked ?? 0,
    reimbursed: o.reimbursed ?? 0,
    reimburses_total: o.reimburses_total ?? 0,
    created_at: o.time,
    raw_json: null,
  });
  return txs[txs.length - 1];
}

// Merchant pools (international where it reads in both languages; local groceries stay local —
// they are data shown as-is and give the feed an authentic, lived-in texture).
const GROCERY = [["Silpo", 5411], ["ATB", 5411], ["Novus", 5411], ["Auchan", 5411], ["Varus", 5411]];
const CAFE = [["Aroma Kava", 5814], ["Starbucks", 5814], ["McDonald's", 5814], ["Lviv Croissants", 5812], ["Puzata Hata", 5812]];
const TRANSPORT = [["Uber", 4121], ["Bolt", 4121], ["Kyiv Metro", 4111], ["WOG fuel", 5541], ["OKKO fuel", 5541]];
const SHOP = [["Rozetka", 5732], ["IKEA", 5712], ["H&M", 5651], ["Amazon", 5942], ["Comfy", 5732]];
const HEALTH = [["Apteka ANC", 5912], ["Dobrobut clinic", 8011], ["Pharmacy 911", 5912]];
const FUN = [["Planeta Kino", 7832], ["Steam", 5816], ["MegoGo", 4899], ["Bowling club", 7996]];
const NOTES = [
  "Weekly groceries.", "Split the bill with a friend.", "Work lunch.", "Impulse buy, regret it.",
  "Birthday gift for mom.", "Refilled the car before the trip.", "Ran out of coffee.",
  "New running shoes.", "Pharmacy — cold meds.", "Team dinner, my round.", "Monthly top-up.",
];

// ---- recurring income & fixed costs (6 months) -------------------------------
// Salary on the 5th of each of the last 6 months into the white card.
for (let m = 5; m >= 0; m--) {
  tx({ time: monthDay(m, 5, 10), account_id: "acc-white", amount: 45_000_00, category_id: 15, merchant: "ACME Corp payroll", comment: "Salary", mcc: 6011 });
}
// Freelance USD income, a few times, into the USD card.
for (const m of [4, 2, 0]) {
  tx({ time: monthDay(m, 12, 15), account_id: "acc-usd", amount: 800_00, category_id: 16, merchant: "Upwork", comment: "Freelance payout", user_note: m === 0 ? "Side project milestone." : null });
}
// Rent — monthly, plan-linked (planned_id=1), from the white card.
for (let m = 5; m >= 0; m--) {
  tx({ time: monthDay(m, 3, 9), account_id: "acc-white", amount: -18_000_00, category_id: 8, merchant: "Landlord (rent)", planned_id: 1, importance: "essential", user_note: m === 5 ? "Rent — fixed monthly." : null });
}
// Utilities — monthly.
for (let m = 5; m >= 0; m--) {
  tx({ time: monthDay(m, 8, 11), account_id: "acc-white", amount: -(2_200_00 + randInt(-300_0, 500_0)), category_id: 7, merchant: "Utilities & internet", importance: "essential" });
}

// ---- subscriptions (plans + their actual charges) ----------------------------
// planned_payments rows (period_amount in the PLAN currency, §CUR-PLAN).
const planned = [
  { id: 1, title: "Rent", kind: "subscription", total_amount: null, period_amount: 18_000_00, period: "month", period_count: 1, start_date: monthDay(6, 3), end_date: null, occurrences: null, category_id: 8, account_id: "acc-white", currency_code: 980, is_active: 1, note: "Apartment rent." },
  { id: 2, title: "Spotify", kind: "subscription", total_amount: null, period_amount: 10_99, period: "month", period_count: 1, start_date: monthDay(6, 7), end_date: null, occurrences: null, category_id: 42, account_id: "acc-usd", currency_code: 840, is_active: 1, note: null },
  { id: 3, title: "Netflix", kind: "subscription", total_amount: null, period_amount: 3_29_00 / 100 * 100, period: "month", period_count: 1, start_date: monthDay(6, 11), end_date: null, occurrences: null, category_id: 42, account_id: "acc-white", currency_code: 980, is_active: 1, note: "Standard plan." },
  { id: 4, title: "Sport Life gym", kind: "subscription", total_amount: null, period_amount: 1_200_00, period: "month", period_count: 1, start_date: monthDay(6, 2), end_date: null, occurrences: null, category_id: 22, account_id: "acc-black", currency_code: 980, is_active: 1, note: null },
  { id: 5, title: "iCloud+", kind: "subscription", total_amount: null, period_amount: 2_99, period: "month", period_count: 1, start_date: monthDay(6, 18), end_date: null, occurrences: null, category_id: 43, account_id: "acc-usd", currency_code: 840, is_active: 1, note: null },
  // Dead subscription: active > 60 days but produces NO actual charges below → `dead_sub`.
  { id: 6, title: "Adobe Creative Cloud", kind: "subscription", total_amount: null, period_amount: 1_099_00, period: "month", period_count: 1, start_date: monthDay(5, 14), end_date: null, occurrences: null, category_id: 43, account_id: "acc-black", currency_code: 980, is_active: 1, note: "Forgot to cancel?" },
];
// Fix the accidental arithmetic on Netflix (write the intended kopiykas explicitly).
planned[2].period_amount = 3_29_00; // ₴329.00 old price

// Actual sub charges. Netflix gets a mid-history PRICE INCREASE (drives price_up + price-drift).
for (let m = 5; m >= 0; m--) {
  tx({ time: monthDay(m, 7, 6), account_id: "acc-usd", amount: -10_99, category_id: 42, merchant: "Spotify", planned_id: 2, importance: "optional" });
  const netflix = m >= 3 ? -3_29_00 : -3_99_00; // raised from ₴329 to ₴399 three months ago
  tx({ time: monthDay(m, 11, 6), account_id: "acc-white", amount: netflix, category_id: 42, merchant: "Netflix", planned_id: 3, importance: "optional" });
  tx({ time: monthDay(m, 2, 8), account_id: "acc-black", amount: -1_200_00, category_id: 22, merchant: "Sport Life gym", planned_id: 4, importance: "discretionary" });
  tx({ time: monthDay(m, 18, 6), account_id: "acc-usd", amount: -2_99, category_id: 43, merchant: "iCloud+", planned_id: 5, importance: "optional" });
}
// Update Netflix plan to the CURRENT (raised) price so `price_up` sees the delta.
planned[2].period_amount = 3_99_00;

// ---- everyday spending over ~185 days ----------------------------------------
// Distribute groceries / cafés / transport / etc. with plausible cadence and jitter.
function spread(daysBack, everyN, jitter, fn) {
  for (let d = daysBack; d > 0; d -= everyN + randInt(-jitter, jitter)) fn(Math.max(0, d));
}
spread(184, 2, 1, (d) => {
  const [m, mcc] = pick(GROCERY);
  const acc = chance(0.15) ? "acc-cash" : chance(0.3) ? "acc-black" : "acc-white";
  tx({ time: daysAgo(d, randInt(9, 20)), account_id: acc, amount: -(80_0 + randInt(0, 820_0)), category_id: 1, merchant: m, mcc, user_note: chance(0.08) ? pick(NOTES) : null, cashback: chance(0.3) ? randInt(1_0, 15_0) : null });
});
spread(184, 3, 1, (d) => {
  const [m, mcc] = pick(CAFE);
  tx({ time: daysAgo(d, randInt(8, 21)), account_id: chance(0.4) ? "acc-black" : "acc-white", amount: -(60_0 + randInt(0, 360_0)), category_id: 2, merchant: m, mcc, importance: chance(0.5) ? "discretionary" : null, user_note: chance(0.06) ? pick(NOTES) : null });
});
spread(184, 3, 1, (d) => {
  const [m, mcc] = pick(TRANSPORT);
  const fuel = m.includes("fuel");
  tx({ time: daysAgo(d, randInt(7, 22)), account_id: chance(0.3) ? "acc-black" : "acc-white", amount: -(fuel ? randInt(1_000_0, 2_500_0) : 40_0 + randInt(0, 260_0)), category_id: 3, merchant: m, mcc });
});
spread(184, 9, 3, (d) => {
  const [m, mcc] = pick(FUN);
  tx({ time: daysAgo(d, randInt(12, 23)), account_id: "acc-white", amount: -(120_0 + randInt(0, 600_0)), category_id: 6, merchant: m, mcc, importance: "optional" });
});
spread(184, 8, 3, (d) => {
  const [m, mcc] = pick(HEALTH);
  tx({ time: daysAgo(d, randInt(9, 19)), account_id: "acc-white", amount: -(150_0 + randInt(0, 2_800_0)), category_id: 4, merchant: m, mcc, importance: "essential", user_note: chance(0.2) ? "Pharmacy — meds." : null });
});
// Bigger occasional shopping (clothes / electronics / home).
spread(184, 12, 4, (d) => {
  const [m, mcc] = pick(SHOP);
  const cat = m === "IKEA" ? 8 : m === "H&M" ? 5 : m === "Amazon" ? 9 : pick([5, 8, 9]);
  const foreign = m === "Amazon";
  tx({
    time: daysAgo(d, randInt(11, 20)), account_id: chance(0.5) ? "acc-black" : "acc-white",
    amount: -(600_0 + randInt(0, 11_000_0)), category_id: cat, merchant: m, mcc,
    // Amazon on a ₴ card: account currency is ₴, but the operation was in USD (multicurrency).
    original_amount: foreign ? -(randInt(15_00, 90_00)) : null, original_currency: foreign ? 840 : null,
    user_note: chance(0.15) ? pick(NOTES) : null,
  });
});

// ---- uncategorized backlog (drives the `todo` signal + "uncategorized" stats) --
for (let i = 0; i < 11; i++) {
  tx({ time: daysAgo(randInt(1, 28), randInt(9, 21)), account_id: chance(0.5) ? "acc-white" : "acc-black", amount: -(120_0 + randInt(0, 900_0)), merchant: pick(["Terminal 4412", "P2P transfer", "Prom.ua", "OLX", "Local shop", "Kiosk"]) });
}

// ---- cash withdrawals reclassified by real category (EFF_CAT rollup) ----------
for (const d of [40, 80, 130]) {
  tx({ time: daysAgo(d, 13), account_id: "acc-white", amount: -2_000_00, category_id: 13, real_category_id: 1, merchant: "ATM cash withdrawal", user_note: "Cash for the farmers' market." });
}

// ---- refund (§REFUND: incoming, but a SPEND category = negative expense) -------
tx({ time: daysAgo(9, 14), account_id: "acc-white", amount: 1_450_00, category_id: 9, merchant: "Rozetka", comment: "Скасування. Повернення товару", user_note: "Returned the headphones." });

// ---- transfer pair (white → jar), collapsed by transfer_pair_id ---------------
{
  const t = daysAgo(22, 16);
  tx({ time: t, account_id: "acc-white", amount: -3_000_00, category_id: 13, merchant: "To Emergency jar", is_transfer: 1, transfer_pair_id: "tp-1" });
  tx({ time: t + 5, account_id: "acc-jar", amount: 3_000_00, category_id: 13, merchant: "From Mono White", is_transfer: 1, transfer_pair_id: "tp-1" });
}

// ---- split transaction (IKEA → Home + Electronics) ----------------------------
{
  const t = tx({ time: daysAgo(35, 15), account_id: "acc-black", amount: -4_500_00, category_id: 8, merchant: "IKEA", mcc: 5712, user_note: "Desk + a smart lamp." });
  splits.push({ id: 1, tx_id: t.id, category_id: 8, amount: -3_000_00, created_at: t.time });
  splits.push({ id: 2, tx_id: t.id, category_id: 9, amount: -1_500_00, created_at: t.time });
}

// ---- reimbursement v2 (one income covers TWO expenses) ------------------------
// User paid for a dinner and concert tickets; a friend sent ₴1000 covering part of each.
{
  const dinner = tx({ time: daysAgo(18, 20), account_id: "acc-black", amount: -1_500_00, category_id: 2, merchant: "Bao restaurant", reimbursed: 600_00, user_note: "Dinner with friends, I paid." });
  const tickets = tx({ time: daysAgo(18, 21), account_id: "acc-white", amount: -800_00, category_id: 6, merchant: "Concert.ua", reimbursed: 400_00 });
  const income = tx({ time: daysAgo(16, 12), account_id: "acc-white", amount: 1_000_00, merchant: "Split from Andrii", comment: "Sending my share", reimburses_total: 1_000_00, user_note: "Friend's share of dinner + tickets." });
  reimb.push({ id: 1, expense_id: dinner.id, source_tx_id: income.id, amount: 600_00, created_at: income.time });
  reimb.push({ id: 2, expense_id: tickets.id, source_tx_id: income.id, amount: 400_00, created_at: income.time });
}

// ---- event group: weekend trip to Kraków (with budget) ------------------------
const events = [
  { id: 1, name: "Kraków weekend", kind: "trip", color: "#2450C8", icon: "plane", note: "Weekend city break in Kraków with two friends — flights, hotel, food.", is_active: 1, created_at: daysAgo(70), budget: 15_000_00 },
];
{
  const base = 60; // ~2 months ago
  tx({ time: daysAgo(base, 8), account_id: "acc-black", amount: -4_200_00, category_id: 11, merchant: "Ryanair", mcc: 4511, event_id: 1, user_note: "Flights for the trip." });
  tx({ time: daysAgo(base - 1, 15), account_id: "acc-eur", amount: -180_00, category_id: 11, merchant: "Hotel Kazimierz", mcc: 7011, event_id: 1 });
  tx({ time: daysAgo(base - 2, 13), account_id: "acc-eur", amount: -42_00, category_id: 2, merchant: "Pierogi bar", mcc: 5812, event_id: 1 });
  tx({ time: daysAgo(base - 2, 20), account_id: "acc-eur", amount: -55_00, category_id: 2, merchant: "Craft beer pub", mcc: 5813, event_id: 1 });
  tx({ time: daysAgo(base - 3, 12), account_id: "acc-eur", amount: -30_00, category_id: 6, merchant: "Wawel Castle", mcc: 7991, event_id: 1 });
}

// ---- goals -------------------------------------------------------------------
const goals = [
  // Behind schedule → drives `goal_risk`. Manual progress.
  { id: 1, name: "New MacBook Pro", target_amount: 90_000_00, current_amount: 28_000_00, account_id: null, deadline: daysAgo(-75), color: "#7A3E9D", note: "For freelance work.", is_active: 1, created_at: daysAgo(120) },
  // On-track, sourced from the jar balance.
  { id: 2, name: "Emergency fund (3 months)", target_amount: 90_000_00, current_amount: 0, account_id: "acc-jar", deadline: daysAgo(-160), color: "#1F6E4C", note: "Three months of expenses.", is_active: 1, created_at: daysAgo(150) },
];

// ---- budgets (month) — set from actual current-month spend to hit ok/warn/over -
// Compute current calendar-month spend per effective category with the canon's spend rule.
function monthStartTs() {
  const b = new Date(ANCHOR * 1000);
  return Math.floor(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 1) / 1000);
}
function spendByCatThisMonth() {
  const from = monthStartTs();
  const acc = {};
  for (const t of txs) {
    if (t.time < from || t.amount >= 0) continue;
    if (t.transfer_pair_id || t.is_transfer) continue;
    const eff = t.real_category_id ?? t.category_id;
    if (eff == null || eff === 13) continue;
    const uah = t.currency_code === 980 ? -t.amount : Math.round(-t.amount * (RATES[String(t.currency_code)] ?? 0));
    acc[eff] = (acc[eff] ?? 0) + uah;
  }
  return acc;
}
const spent = spendByCatThisMonth();
const round50 = (v) => Math.max(50_00, Math.round(v / 50_00) * 50_00);
const budgets = [
  { id: 1, category_id: 1, period: "month", amount: round50((spent[1] ?? 8_000_00) * 0.85), currency_code: 980 }, // over
  { id: 2, category_id: 2, period: "month", amount: round50((spent[2] ?? 3_000_00) * 0.95), currency_code: 980 }, // warn
  { id: 3, category_id: 3, period: "month", amount: round50((spent[3] ?? 2_500_00) * 1.4), currency_code: 980 },  // ok
  { id: 4, category_id: 6, period: "month", amount: round50((spent[6] ?? 2_000_00) * 1.2), currency_code: 980 },  // ok/warn
  { id: 5, category_id: 8, period: "month", amount: 20_000_00, currency_code: 980 }, // rent-heavy, ok
];

// ---- receipts (drives the receipt-items analytics section) --------------------
const receipts = [];
const receiptItems = [];
{
  // Attach a receipt to a couple of grocery transactions.
  const groceryTxs = txs.filter((t) => t.category_id === 1 && t.amount <= -300_0).slice(0, 2);
  let ri = 0;
  groceryTxs.forEach((t, idx) => {
    const rid = idx + 1;
    receipts.push({ id: rid, transaction_id: t.id, image_key: null, store: t.merchant, purchased_at: t.time, total: -t.amount, currency_code: 980, ai_json: null, created_at: t.time });
    t.receipt_id = rid;
    const items = [["Milk 2.5%", 1, 42_0, 1], ["Bread", 2, 25_0, 1], ["Chicken fillet", 1, 180_0, 1], ["Apples 1kg", 1, 55_0, 1], ["Coffee beans", 1, 320_0, 12]];
    for (const [name, qty, price, cat] of items) receiptItems.push({ id: ++ri, receipt_id: rid, name, qty, price, category_id: cat });
  });
}

// ---- name-locked merchant + a couple of importance overrides already set above -
for (const t of txs) {
  if (t.merchant === "Landlord (rent)") { t.name_locked = 1; break; }
}

// ---- health index history (45 daily points, gentle upward trend + noise) ------
const health_history = [];
for (let d = 45; d >= 0; d--) {
  const ts = daysAgo(d, 6);
  const day = new Date(ts * 1000).toISOString().slice(0, 10);
  const base = 60 + (45 - d) * 0.18; // ~60 → ~68
  const score = Math.max(0, Math.min(100, Math.round(base + (rnd() - 0.5) * 4)));
  health_history.push({ day, score, ts });
}

// ---- ai notes on a handful of transactions (AI-enriched look) -----------------
// Not on all — a few tokens of context read as real usage, wall-to-wall notes read as a form.
const AI_NOTES = {
  "Ryanair": "Round-trip flights booked 6 weeks ahead — cheaper than buying last minute.",
  "IKEA": "One-off furniture purchase, split across Home and Electronics.",
  "Netflix": "Recurring subscription — price went up recently.",
  "Sport Life gym": "Fixed monthly membership.",
  "Rozetka": "Electronics; one of these was later refunded.",
};
let aiTagged = 0;
for (const t of txs) {
  if (aiTagged >= 8) break;
  if (t.merchant && AI_NOTES[t.merchant] && !t.ai_note) { t.ai_note = AI_NOTES[t.merchant]; aiTagged++; }
}

// ---- pre-baked notifications feed (P4.3) --------------------------------------
// Plain English title/body (notif_key null, like the free-text `ai` kind) — the demo audience is
// English and this avoids depending on the render templates' exact param shapes. Unread so the
// bell shows a count. The daily cron that normally fills this never runs for a demo object.
const notifications = [
  { id: 1, kind: "deadline", title: "Rent due in 2 days", body: "₴18,000 · leaves the White card on the 3rd.", severity: "warn", entity_type: "planned", entity_id: "1", dedup_key: "demo:deadline:rent", created_at: daysAgo(1, 8), read_at: null, pushed_tg_at: null },
  { id: 2, kind: "budget", title: 'Budget "Groceries" almost exhausted', body: "You've used about 92% of this month's grocery envelope.", severity: "warn", entity_type: "category", entity_id: "1", dedup_key: "demo:budget:groceries", created_at: daysAgo(2, 9), read_at: null, pushed_tg_at: null },
  { id: 3, kind: "price_up", title: "Netflix got more expensive", body: "Was ₴329, now ₴399 (+₴70 · ₴840/yr).", severity: "info", entity_type: "planned", entity_id: "3", dedup_key: "demo:price_up:netflix", created_at: daysAgo(4, 6), read_at: null, pushed_tg_at: null },
  { id: 4, kind: "dead_sub", title: "Adobe Creative Cloud — no charges seen", body: "Active over 60 days but nothing has been billed. Cancel if unused.", severity: "info", entity_type: "planned", entity_id: "6", dedup_key: "demo:dead_sub:adobe", created_at: daysAgo(5, 7), read_at: null, pushed_tg_at: null },
  { id: 5, kind: "goal_risk", title: 'Goal "New MacBook Pro" is falling behind', body: "Saved 31%, but more of the time window has passed. ~₴7,700/mo to make it.", severity: "info", entity_type: "goal", entity_id: "1", dedup_key: "demo:goal_risk:macbook", created_at: daysAgo(6, 10), read_at: null, pushed_tg_at: null },
  { id: 6, kind: "ai", title: "Subscriptions are creeping up", body: "Five active subscriptions now run about ₴1,050/mo combined — the Netflix increase and an unused Adobe plan are the drivers.", severity: "info", entity_type: null, entity_id: null, dedup_key: "demo:ai:subs", created_at: daysAgo(3, 8), read_at: null, pushed_tg_at: null },
];

// ---- pre-baked advisor + reports (P4.3) ---------------------------------------
// Funds in MINOR units (kopiykas), matching fundsBreakdown; the AI free-text speaks ₴ whole.
const FUNDS = { cushion: 245_550_00, debt: 1_200_00, investment: 273_900_00, own: 244_350_00, burn: 32_500_00, runway: 7.6 };
const advisor = {
  runway_comment: "You've got roughly 7–8 months of runway if income stopped today — comfortable, but most of your net worth is locked in investments, not the liquid cushion.",
  summary: "Spending is steady around ₴32,500/mo. The biggest quiet leak is subscriptions, and the credit card carries a small revolving balance worth clearing before it grows.",
  facts: [
    { label: "Liquid cushion", amount: 245550, category: null, delta_pct: null, tone: "pos" },
    { label: "Monthly burn", amount: 32500, category: null, delta_pct: 4, tone: "neutral" },
    { label: "Credit card debt", amount: 1200, category: null, delta_pct: null, tone: "neg" },
    { label: "Groceries this month", amount: 9800, category: "Groceries", delta_pct: 12, tone: "neg" },
  ],
  suggestions: [
    { title: "Cancel the unused Adobe plan", detail: "Adobe Creative Cloud (~₴1,099/mo) has had no charges linked for over two months. Cancelling frees ~₴13,000/yr.", action: null },
    { title: "Clear the ₴1,200 card balance", detail: "Small now, but it's the only thing accruing interest. Pay it from the White card before the statement date.", action: null },
    { title: "Cap groceries with an envelope", detail: "You're pacing ~12% above a sensible grocery budget. A ₴9,000 envelope keeps it visible.", action: { type: "create_budget", label: "Groceries budget", category_id: 1, category_name: "Groceries", amount_uah: 9000 } },
  ],
  own_funds: FUNDS.own, cushion: FUNDS.cushion, debt: FUNDS.debt, investment: FUNDS.investment,
  monthly_burn: FUNDS.burn, runway_months: FUNDS.runway,
  usage: { in: 2100, out: 480, usd: 0.004 },
  generated_at: daysAgo(1, 12),
};
const advisor_history = [
  { generated_at: daysAgo(1, 12), summary: advisor.summary, runway_months: 7.6, monthly_burn: FUNDS.burn, own_funds: FUNDS.own, cushion: FUNDS.cushion },
  { generated_at: daysAgo(14, 12), summary: "Runway holding steady; subscriptions ticking up.", runway_months: 7.3, monthly_burn: 33_100_00, own_funds: 238_000_00, cushion: 240_000_00 },
  { generated_at: daysAgo(30, 12), summary: "Cushion rebuilt after the Kraków trip.", runway_months: 7.0, monthly_burn: 33_800_00, own_funds: 231_000_00, cushion: 233_500_00 },
];

function reportData(period) {
  return {
    headline: period === "month" ? "A steady month with a subscription drift" : "A calm week, groceries running warm",
    summary: period === "month"
      ? "Spending landed near ₴32,500, close to your usual. Income comfortably covered it. The one thing worth watching is subscriptions, which quietly rose after the Netflix increase."
      : "Nothing alarming this week. Groceries are pacing a little above budget and one large IKEA purchase stands out, but it was a planned one-off.",
    sections: [
      { title: "Where the money went", body: "Rent and groceries remain the two biggest lines, together about 60% of spend. Discretionary categories (cafés, entertainment) were in their normal range." },
      { title: "What changed", body: "Netflix moved from ₴329 to ₴399. An Adobe plan is still active with no charges linked — likely forgotten." },
    ],
    category_breakdown: [
      { name: "Home & household", amount_uah: 21000, delta_pct: 2, note: "Rent, stable." },
      { name: "Groceries", amount_uah: 9800, delta_pct: 12, note: "Running a bit warm." },
      { name: "Transport", amount_uah: 2600, delta_pct: -5, note: "Slightly down." },
      { name: "Subscriptions", amount_uah: 1050, delta_pct: 18, note: "Netflix increase." },
    ],
    anomalies: [
      { label: "Adobe Creative Cloud", detail: "Active over 60 days, no actual charges — probably an unused subscription.", severity: "warn" },
    ],
    predictions: { next_period_spend_uah: period === "month" ? 33000 : 8200, runway_months: 7.6, note: "Assumes the current pace and no new one-offs." },
    advice: [
      { title: "Trim subscriptions", detail: "Cancelling the unused Adobe plan saves ~₴13,000/yr.", action: null },
      { title: "Watch groceries", detail: "A grocery envelope keeps the 12% overspend visible.", action: { type: "create_budget", label: "Groceries budget", category_id: 1, category_name: "Groceries", amount_uah: 9000 } },
    ],
  };
}
const HAIKU = "claude-haiku-4-5-20251001";
const ai_reports = [
  { id: 1, period_type: "week", period_from: daysAgo(7, 0), period_to: daysAgo(0, 23), created_at: daysAgo(0, 7), model: HAIKU, cost_usd: 0.006, summary: "A calm week; groceries a touch over budget, one planned IKEA purchase.", data_json: JSON.stringify(reportData("week")) },
  { id: 2, period_type: "month", period_from: monthDay(1, 1, 0), period_to: monthDay(0, 1, 0) - 1, created_at: daysAgo(2, 9), model: HAIKU, cost_usd: 0.011, summary: "Steady month near ₴32,500; subscriptions drifting up after the Netflix increase.", data_json: JSON.stringify(reportData("month")) },
];

// ---- app_state ---------------------------------------------------------------
const app_state = [
  { key: "rates", value: JSON.stringify(RATES) },
  { key: "locale", value: "en" }, // demo audience is English (§12)
  { key: "period_mode", value: "calendar" },
  // PLAIN TEXT, not JSON: `finance_profile` is read straight into the About-me textarea and into
  // every AI prompt (advisor.ts getProfile). Seeding `{"about":"…"}` showed the raw JSON to the
  // visitor and fed the model a wrapper it then had to guess at.
  {
    key: "finance_profile",
    value: "Software engineer, ~34k UAH/mo net salary plus occasional USD freelance. Renting an apartment. Wants a longer runway and to stop leaking money on subscriptions.",
  },
  // Pre-baked AI so the Advisor page is full before any (capped) live generation (P4.3).
  { key: "advisor", value: JSON.stringify(advisor) },
  { key: "advisor_history", value: JSON.stringify(advisor_history) },
];

// ---- assemble + write --------------------------------------------------------
const dataset = {
  meta: {
    anchor: ANCHOR,
    generatedBy: "scripts/seed-demo.mjs",
    // Fields the loader must shift by (nowAtLoad - anchor). `health_history.day` is derived from
    // `ts` — recompute it after shifting.
    timeFields: {
      accounts: ["updated_at"],
      transactions: ["time", "created_at"],
      planned_payments: ["start_date", "end_date"],
      savings_goals: ["deadline", "created_at"],
      event_groups: ["created_at"],
      tx_splits: ["created_at"],
      tx_reimbursements: ["created_at"],
      receipts: ["purchased_at", "created_at"],
      health_history: ["ts"],
      notifications: ["created_at"],
      ai_reports: ["period_from", "period_to", "created_at"],
    },
  },
  accounts,
  transactions: txs,
  planned_payments: planned,
  savings_goals: goals,
  event_groups: events,
  budgets,
  tx_splits: splits,
  tx_reimbursements: reimb,
  receipts,
  receipt_items: receiptItems,
  health_history,
  notifications,
  ai_reports,
  app_state,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");

// ---- console summary (sanity at a glance) ------------------------------------
const incomeUah = txs.filter((t) => t.amount > 0).reduce((s, t) => s + (t.currency_code === 980 ? t.amount : Math.round(t.amount * RATES[String(t.currency_code)])), 0);
const spendUah = txs.filter((t) => t.amount < 0).reduce((s, t) => s + (t.currency_code === 980 ? -t.amount : Math.round(-t.amount * RATES[String(t.currency_code)])), 0);
console.log(`✓ wrote ${OUT}`);
console.log(`  transactions: ${txs.length} | accounts: ${accounts.length} | plans: ${planned.length} | goals: ${goals.length} | events: ${events.length} | budgets: ${budgets.length}`);
console.log(`  splits: ${splits.length} | reimbursements: ${reimb.length} | receipts: ${receipts.length} | health points: ${health_history.length}`);
console.log(`  uncategorized: ${txs.filter((t) => t.category_id == null && !t.transfer_pair_id).length} | span days: ${Math.round((ANCHOR - Math.min(...txs.map((t) => t.time))) / DAY)}`);
console.log(`  prebaked: notifications ${notifications.length} | ai_reports ${ai_reports.length} | advisor+history | ai_notes ${aiTagged}`);
console.log(`  gross income ≈ ₴${Math.round(incomeUah / 100).toLocaleString()} | gross spend ≈ ₴${Math.round(spendUah / 100).toLocaleString()}`);
