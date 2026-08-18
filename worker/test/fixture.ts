/**
 * Deterministic dataset for the characterization tests.
 *
 * Selection rule: every case here is one that ALREADY produced a wrong number in production, or
 * one the canon explicitly carves out. A fixture of plain well-formed expenses would go green
 * through the exact refactor it is supposed to guard.
 *
 * Covered, with the rule each case pins:
 *   §SPLIT         a split expense across two categories        (sum must not double-count)
 *   §REFUND        a cancellation with an expense category      (negative spend, NOT income)
 *                  an uncategorised incoming P2P                (genuine income, NOT a refund)
 *   §COMPENSATION  fully and partly reimbursed expenses         (net spend; remainder is income)
 *   transfers      a paired transfer + a bucket-13 leg          (outside spending entirely)
 *   real category  a withdrawal re-categorised to its true use  (spend in THAT category)
 *   roll-up        spending on a sub-category                   (must land on the parent)
 *   holds          hold = 1                                     (counted; mono only sends settled)
 *   multicurrency  USD and EUR rows                             (converted via app_state.rates)
 *   §CUR-PLAN      a USD subscription                           (converted before averaging)
 *   §SUB-MONTH     monthly, quarterly and weekly plans          (period normalised to a month)
 *   §6 importance  a transaction-level override                 (beats the category default)
 *   accounts       credit / jar / investment / foreign          (cushion vs debt vs investment)
 *
 * History depth: eight months back from the frozen instant. `categoryMonthlyLevels` only looks
 * at COMPLETE months and needs several to decide fixed-cost vs variable, so a shallow fixture
 * would leave the most consequential helper in the project effectively untested.
 */
import type { MemDb } from "./harness.ts";

/** Frozen "now": Thursday 14 May 2026, 12:00 Kyiv. Mid-week, mid-month, mid-day — so every
 *  preset has both elapsed and remaining time, and no boundary hides an off-by-one. */
export const FROZEN_NOW_ISO = "2026-05-14T09:00:00.000Z";
const NOW = Math.floor(new Date(FROZEN_NOW_ISO).getTime() / 1000);
const DAY = 86400;

const UAH = 980, USD = 840, EUR = 978;

/** Small LCG so the baseline history is varied but identical on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function exec(db: MemDb, sql: string, params: unknown[] = []): void {
  const stmt = db.raw.prepare(sql);
  stmt.run(...(params.map((p) => (p === undefined ? null : p)) as never[]));
}

let txSeq = 0;
function tx(db: MemDb, row: Record<string, unknown>): string {
  const id = (row.id as string) ?? `tx${String(++txSeq).padStart(4, "0")}`;
  const full: Record<string, unknown> = { id, account_id: "acc-uah", source: "mono", currency_code: UAH, ...row };
  const cols = Object.keys(full);
  exec(db, `INSERT INTO transactions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    cols.map((c) => full[c]));
  return id;
}

export function seed(db: MemDb): void {
  // Reset the id counter per seeded database.
  //
  // It is module state, so without this the ids a scenario gets depend on how many scenarios ran
  // BEFORE it — which quietly undid the write suite's "a fresh database per scenario" guarantee:
  // inserting one case anywhere rewrote the golden of every case after it, and those diffs are
  // pure noise that trains you to re-record without reading. Found when batch E added two
  // knowledge scenarios and five unrelated ones went red.
  txSeq = 0;

  // ---- app state -------------------------------------------------------------------------
  // Round rates, so any figure in a golden file can be checked by hand.
  for (const [k, v] of [
    ["rates", JSON.stringify({ [USD]: 40, [EUR]: 45 })],
    ["period_mode", "calendar"],
    ["locale", "uk"],
  ] as const) {
    exec(db, "INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)", [k, v]);
  }

  // ---- accounts --------------------------------------------------------------------------
  // Deliberately one of each kind the funds breakdown treats differently: a plain liquid
  // account, a foreign-currency one, a CREDIT card in debt (own funds go negative — the bug
  // fixed on 2026-08-03), a jar, and an investment account that must stay out of the cushion.
  const accounts: [string, string, string, number, number, number, string][] = [
    ["acc-uah",  "black",       "Картка ₴",   UAH, 4_500_00, 0,        "liquid"],
    ["acc-usd",  "fop",         "Рахунок $",  USD,   800_00, 0,        "liquid"],
    ["acc-cred", "black",       "Кредитка",   UAH,   200_00, 1_000_00, "liquid"],
    ["acc-jar",  "jar",         "Банка",      UAH, 3_000_00, 0,        "liquid"],
    ["acc-inv",  "crypto",      "Крипта",     USD, 1_200_00, 0,        "investment"],
  ];
  for (const [id, type, title, cur, bal, limit, role] of accounts) {
    exec(db,
      `INSERT INTO accounts (id, type, title, currency_code, balance, credit_limit, is_manual,
         is_active, updated_at, role) VALUES (?,?,?,?,?,?,0,1,?,?)`,
      [id, type, title, cur, bal, limit, NOW, role]);
  }

  // ---- baseline history: eight complete months ---------------------------------------------
  // Enough depth for categoryMonthlyLevels to classify fixed-cost vs variable, and for the
  // 6-month trend endpoints to have something to trend.
  const rnd = lcg(20260514);
  for (let monthsBack = 8; monthsBack >= 0; monthsBack--) {
    const base = NOW - monthsBack * 30 * DAY;

    // Rent: a stable fixed cost. Its whole reason for being here is that the level helper must
    // treat it differently from a variable category.
    tx(db, { time: base - 2 * DAY, amount: -12_000_00, category_id: 8, merchant: "Оренда" });

    // Groceries: several variable purchases, some on the SUB-category to exercise the roll-up.
    for (let i = 0; i < 4; i++) {
      tx(db, {
        time: base - i * 5 * DAY,
        amount: -Math.round((300 + rnd() * 500)) * 100,
        category_id: i % 2 === 0 ? 30 : 1,
        merchant: i % 2 === 0 ? "Сільпо" : "АТБ",
      });
    }

    // Transport, discretionary.
    tx(db, { time: base - 3 * DAY, amount: -Math.round(120 + rnd() * 180) * 100, category_id: 35, merchant: "Таксі" });

    // Salary: the income side needs to be non-trivial for savings-rate style figures.
    tx(db, { time: base - 12 * DAY, amount: 45_000_00, category_id: 15, merchant: "Зарплата" });
  }

  // ---- §SPLIT: one expense divided across two categories -----------------------------------
  // The join in STATS_JOINS multiplies this row into parts. Totals must use EFF_AMOUNT and
  // counts must use COUNT(DISTINCT t.id), or the same purchase is counted twice.
  const splitId = tx(db, { time: NOW - 4 * DAY, amount: -2_000_00, category_id: 1, merchant: "Ашан" });
  for (const [cat, amount] of [[1, -1_400_00], [8, -600_00]] as const) {
    exec(db, "INSERT INTO tx_splits (tx_id, category_id, amount, created_at) VALUES (?,?,?,?)",
      [splitId, cat, amount, NOW]);
  }

  // ---- §REFUND -----------------------------------------------------------------------------
  // A cancellation carrying an EXPENSE category: negative spending in that category, never income.
  tx(db, { time: NOW - 6 * DAY, amount: 450_00, category_id: 3, merchant: "Скасування. Переліт" });
  // An uncategorised incoming P2P: real income. The mirror case — proof the refund rule needs an
  // EXISTING category, or every incoming transfer would be silently reclassified as a refund.
  tx(db, { time: NOW - 7 * DAY, amount: 1_200_00, merchant: "Від: друг" });

  // ---- §COMPENSATION -----------------------------------------------------------------------
  // Fully covered: nets to zero spending, and the covering income is not earnings.
  const hotel = tx(db, { time: NOW - 9 * DAY, amount: -1_800_00, category_id: 11, merchant: "Готель", reimbursed: 1_800_00 });
  const fromColleague = tx(db, { time: NOW - 9 * DAY, amount: 1_800_00, merchant: "Від: колега", reimburses_total: 1_800_00 });
  // Partly covered: the remainder stays spending, AND the unallocated part of the incoming
  // transfer stays income. This is the v2 bug — money used to vanish from both sides.
  const tickets = tx(db, { time: NOW - 10 * DAY, amount: -3_000_00, category_id: 11, merchant: "Квитки", reimbursed: 1_000_00 });
  const fromFriend2 = tx(db, { time: NOW - 10 * DAY, amount: 2_500_00, merchant: "Від: друг 2", reimburses_total: 1_000_00 });
  // The allocations THEMSELVES, not just their denormalised shadow.
  //
  // `reimbursed` / `reimburses_total` are derived columns: `rbRecalc` is their single writer and
  // it computes both from this table. Seeding the columns without the rows produced a state
  // production cannot reach — and it was not harmless. The write tests found it: an endpoint that
  // recomputes `available` from `tx_reimbursements` saw every source as fully spent, so a
  // scenario aimed at the "compensation exceeds the expense" ceiling was rejected earlier, by the
  // source-exhausted guard, and that ceiling went untested.
  //
  // The canon reads the denormalised columns, so the analytics goldens are unaffected by this.
  for (const [expense, source, amount] of [
    [hotel, fromColleague, 1_800_00],
    [tickets, fromFriend2, 1_000_00],
  ] as const) {
    exec(db, "INSERT INTO tx_reimbursements (expense_id, source_tx_id, amount, created_at) VALUES (?,?,?,?)",
      [expense, source, amount, NOW]);
  }

  // ---- transfers ---------------------------------------------------------------------------
  // A detected pair: both legs are outside spending and income entirely.
  tx(db, { id: "pair-out", time: NOW - 11 * DAY, amount: -5_000_00, transfer_pair_id: "p1", is_transfer: 1 });
  tx(db, { id: "pair-in", time: NOW - 11 * DAY, amount: 5_000_00, transfer_pair_id: "p1", is_transfer: 1,
    account_id: "acc-jar" });
  // Bucket 13 with no pair: still outside the canon, on category alone.
  tx(db, { time: NOW - 12 * DAY, amount: -2_000_00, category_id: 13, merchant: "Зняття готівки" });
  // A withdrawal re-categorised to what it was ACTUALLY spent on: spending in that category.
  tx(db, { time: NOW - 13 * DAY, amount: -900_00, category_id: 13, real_category_id: 2, merchant: "Зняття" });

  // ---- holds, importance override, multicurrency --------------------------------------------
  tx(db, { time: NOW - 1 * DAY, amount: -350_00, category_id: 2, merchant: "Кафе", hold: 1 });
  // §6: the row-level override must beat the category default (Кафе is discretionary).
  tx(db, { time: NOW - 2 * DAY, amount: -600_00, category_id: 2, merchant: "Обід", importance: "essential" });
  tx(db, { time: NOW - 5 * DAY, amount: -50_00, currency_code: USD, account_id: "acc-usd",
    category_id: 43, merchant: "Хмара" });
  tx(db, { time: NOW - 8 * DAY, amount: -30_00, currency_code: EUR, account_id: "acc-usd",
    category_id: 6, merchant: "Концерт" });

  // ---- planned payments --------------------------------------------------------------------
  // §CUR-PLAN: period_amount is in the PLAN's currency — a $10 plan must not weigh 10 ₴.
  // §SUB-MONTH: the monthly burden differs per period; a quarterly plan is not a full charge
  // every month, and a weekly one is ~4.3 charges.
  const plans: [string, string, number, number, number, number][] = [
    ["Стрімінг",  "monthly",    199_00, UAH, NOW - 200 * DAY, 42],
    ["Хмара",     "monthly",     10_00, USD, NOW - 150 * DAY, 43],
    ["Страховка", "quarterly", 3_600_00, UAH, NOW - 300 * DAY, 14],
    ["Прибирання", "weekly",     500_00, UAH, NOW - 90 * DAY, 8],
  ];
  for (const [title, period, amount, cur, start, cat] of plans) {
    exec(db,
      `INSERT INTO planned_payments (title, kind, period_amount, period, start_date, category_id,
         is_active, currency_code, period_count) VALUES (?, 'subscription', ?, ?, ?, ?, 1, ?, 1)`,
      [title, amount, period, start, cat, cur]);
  }

  // ---- budgets -----------------------------------------------------------------------------
  // One comfortably under, one deliberately blown, so budgetStatus has both branches.
  for (const [cat, amount] of [[1, 15_000_00], [2, 1_000_00]] as const) {
    exec(db, "INSERT INTO budgets (category_id, period, amount, currency_code) VALUES (?, 'month', ?, ?)",
      [cat, amount, UAH]);
  }
}

/** The custom category the cascade scenarios delete, and its sub-category. */
export const CASCADE_CAT = 900;
export const CASCADE_SUBCAT = 901;
/** Where those scenarios reassign to — an ordinary seeded category (Кафе). */
export const CASCADE_TARGET = 2;

/**
 * Extra rows for the `DELETE /categories/:id` cascade, seeded ON TOP of `seed()`.
 *
 * Kept OUT of `seed()` on purpose. A category carrying spending would move every analytics
 * golden, and those snapshots are the baseline the whole refactor is measured against — a
 * fixture change that churns them destroys the only evidence that nothing else moved.
 *
 * One row per table the handler touches, because the cascade's correctness is not "the category
 * is gone" but "every FK that pointed at it was dealt with, in an order SQLite accepts". Explicit
 * ids instead of AUTOINCREMENT so the golden files stay readable and stable.
 */
export function seedCategoryCascade(db: MemDb): void {
  exec(db, "INSERT INTO categories (id, name, icon, color, parent_id, is_income, is_custom, importance) VALUES (?,?,?,?,?,0,1,?)",
    [CASCADE_CAT, "Хобі", "dots", "#6B7A74", null, "optional"]);
  exec(db, "INSERT INTO categories (id, name, icon, color, parent_id, is_income, is_custom, importance) VALUES (?,?,?,?,?,0,1,?)",
    [CASCADE_SUBCAT, "Настолки", "dots", "#6B7A74", CASCADE_CAT, null]);

  // Both category columns on transactions: the handler reassigns them in two separate statements,
  // and `real_category_id` is the one a reader forgets (§R2-TX4 lives on it).
  tx(db, { id: "casc-main", time: NOW - 3 * DAY, amount: -700_00, category_id: CASCADE_CAT, merchant: "Ігротека" });
  tx(db, { id: "casc-real", time: NOW - 3 * DAY, amount: -400_00, category_id: 13,
    real_category_id: CASCADE_CAT, merchant: "Зняття на хобі" });

  // Two tagged rows, and the second is ALSO tagged with the reassign target. That is the only
  // input that exercises the de-duplicating DELETE — without it, reassignment would collide with
  // the (transaction_id, category_id) primary key and the whole cascade would fail.
  exec(db, "INSERT INTO transaction_tags (transaction_id, category_id) VALUES (?,?)", ["casc-main", CASCADE_CAT]);
  exec(db, "INSERT INTO transaction_tags (transaction_id, category_id) VALUES (?,?)", ["casc-real", CASCADE_CAT]);
  exec(db, "INSERT INTO transaction_tags (transaction_id, category_id) VALUES (?,?)", ["casc-real", CASCADE_TARGET]);

  // Learned aliases — the FK that actually threw a 500 in production when it was left out.
  exec(db, "INSERT INTO merchant_aliases (match_type, raw_key, display_name, category_id, created_at, source) VALUES ('mono_desc',?,?,?,?, 'manual')",
    ["igroteka", "Ігротека", CASCADE_CAT, NOW]);
  exec(db, "INSERT INTO merchant_aliases (match_type, raw_key, display_name, real_category_id, created_at, source) VALUES ('mono_desc',?,?,?,?, 'ai')",
    ["znyattya-hobi", "Зняття на хобі", CASCADE_CAT, NOW]);

  // Receipt line items (FK on categories, via a receipt).
  exec(db, "INSERT INTO receipts (id, transaction_id, store, purchased_at, total, currency_code) VALUES (1, 'casc-main', 'Ігротека', ?, ?, ?)",
    [NOW - 3 * DAY, -700_00, UAH]);
  exec(db, "INSERT INTO receipt_items (receipt_id, name, qty, price, category_id) VALUES (1, 'Гра', 1, 70000, ?)",
    [CASCADE_CAT]);

  // `rules.category_id` is NOT NULL, which is why this one row splits the handler in two: with a
  // target the rule moves, without one it must be DELETED rather than nulled.
  exec(db, "INSERT INTO rules (match_type, pattern, category_id, priority) VALUES ('text', 'ігротека', ?, 0)",
    [CASCADE_CAT]);

  exec(db, `INSERT INTO planned_payments (title, kind, period_amount, period, start_date, category_id,
      is_active, currency_code, period_count) VALUES ('Клуб', 'subscription', ?, 'monthly', ?, ?, 1, ?, 1)`,
    [300_00, NOW - 60 * DAY, CASCADE_CAT, UAH]);
  exec(db, "INSERT INTO budgets (category_id, period, amount, currency_code) VALUES (?, 'month', 100000, ?)",
    [CASCADE_CAT, UAH]);
}

/** The event the planning scenarios patch, delete and read. */
export const EVENT_ID = 700;
/** Its plan line item, and the stored report the delete scenario removes. */
export const EVENT_PLANNED_ID = 710;
export const REPORT_ID = 720;

/**
 * Extra rows for the planning surface — events, plan line items and a stored AI report.
 *
 * Out of `seed()` for the same reason as the cascade rows: an event carrying spending would move
 * `/events`, `/events/:id` and the `byEvent` breakdown in every `/analytics/overview` golden.
 *
 * The two attached transactions are deliberately in DIFFERENT currencies. Both event endpoints
 * roll their totals up in ₴ through `baseMult`, and both once filtered on `currency_code = 980`
 * instead — which is the worst possible place for that hole, since a trip is exactly where
 * foreign currency shows up. A single-currency event would go green through the bug.
 */
export function seedPlanning(db: MemDb): void {
  exec(db, "INSERT INTO event_groups (id, name, kind, color, icon, note, is_active, created_at, budget) VALUES (?,?,?,?,?,?,1,?,?)",
    [EVENT_ID, "Карпати", "trip", "#334455", "star", "зимова поїздка", NOW - 40 * DAY, 20_000_00]);
  // An archived one, so a list read has something it must NOT return.
  exec(db, "INSERT INTO event_groups (id, name, kind, is_active, created_at) VALUES (701, 'Старий івент', 'event', 0, ?)",
    [NOW - 300 * DAY]);

  tx(db, { id: "ev-uah", time: NOW - 30 * DAY, amount: -3_000_00, category_id: 11, merchant: "Готель Карпати", event_id: EVENT_ID });
  tx(db, { id: "ev-eur", time: NOW - 29 * DAY, amount: -100_00, currency_code: EUR, account_id: "acc-usd",
    category_id: 3, merchant: "Підйомник", event_id: EVENT_ID });
  tx(db, { id: "ev-back", time: NOW - 28 * DAY, amount: 500_00, merchant: "Повернення за житло", event_id: EVENT_ID });

  exec(db, "INSERT INTO event_planned (id, event_id, label, amount, category_id, created_at) VALUES (?,?,?,?,?,?)",
    [EVENT_PLANNED_ID, EVENT_ID, "Житло", 8_000_00, 11, NOW - 40 * DAY]);
  exec(db, "INSERT INTO event_planned (event_id, label, amount, category_id, created_at) VALUES (?,?,?,?,?)",
    [EVENT_ID, "Підйомники", 4_000_00, null, NOW - 40 * DAY]);

  exec(db, `INSERT INTO ai_reports (id, period_type, period_from, period_to, created_at, model, cost_usd, summary, data_json)
      VALUES (?, 'week', ?, ?, ?, 'claude-haiku', 0.004, 'Тиждень як тиждень', ?)`,
    [REPORT_ID, NOW - 14 * DAY, NOW - 7 * DAY, NOW - 7 * DAY, JSON.stringify({ headline: "Тиждень як тиждень" })]);

  // A dismissed candidate, so the detect endpoint has an exclusion to honour.
  exec(db, "INSERT INTO planned_dismissed (merchant, created_at) VALUES ('таксі', ?)", [NOW - 20 * DAY]);
}
