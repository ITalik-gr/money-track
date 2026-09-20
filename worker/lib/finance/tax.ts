/**
 * §TAX-RESERVE · §TAX-LIMIT · §TAX-DUE — what is owed, what is reserved, and when it is due.
 *
 * THE DISTINCTION THE WHOLE MODULE RESTS ON: an ACCRUED obligation is not a PAID expense. The tax
 * categories (24–28) have answered «where did the money go» since migration 0005 and cannot answer
 * «what do I already owe». Money that is already promised to the state is sitting in the same
 * balance as money that is free, and nothing in the app distinguished them.
 *
 * WHY ACCRUAL AND NOT A PERCENTAGE. The idea this replaced was «set aside N% of every payment».
 * That is an estimate, and a tax is not an estimate: for group 3 the liability is exactly 5% (or
 * 3%) plus 1% of the income that actually arrived, plus a fixed monthly contribution. Computing it
 * exactly costs the same as guessing it and is right.
 *
 * ⚠️ §TAX-UAH — EVERY figure here is hryvnia, whatever the reader's base currency is (§BASE-CUR).
 * The state levies in hryvnia; a tax bill shown in dollars would be a number that exists nowhere,
 * and one the user would then convert back at a different rate than the one it was computed from.
 * This is the single deliberate exception to «the currency of the answer is the reader's».
 *
 * ⚠️ Not tax advice, and the screen says so. Every number here follows from what the user entered
 * (group, rate, exemption) — docs/TAX.md §1.
 */
import type { AppDb } from "../platform/db-shim.ts";
import * as taxRepo from "../../repo/tax.ts";
import { getState, setState } from "./repo.ts";
import { localMidnight, localParts, localQuarterStart, localYearStart, localYmd } from "./time.ts";
import { DEFAULT_PROFILE, ratesFor, taxOnIncome, type TaxProfile } from "./tax-rates.ts";

const PROFILE_KEY = "tax_profile";
const DAY = 86_400;

export type ObligationKind = "single_tax" | "military_levy" | "social_contribution";

/**
 * §FOP-GATE — WHO may reach the ФОП module at all, asked once.
 *
 * The module ships unfinished (owner, 2026-09-20: «ще і близько не так як я планував»), so it is
 * the owner's alone until he says otherwise — including in the demo sandbox, where a stranger
 * would otherwise meet a half-built tax screen as if it were the product.
 *
 * A gate on the ENV rather than a stored flag, for the reason every owner-only resource here is:
 * a stored one can be flipped by whoever reaches the write endpoint, and the write endpoint is
 * part of what is being hidden. `readProfile` cannot ask this itself — it takes a `db`, not an
 * env — so each DOOR asks it, and `fop-gate.test.ts` pins the class rather than the list.
 */
export function fopAvailable(env: { IS_OWNER?: boolean }): boolean {
  // Truthy, not `=== true`: the flag arrives as a header value in some paths and as a boolean in
  // others, and every other owner gate in the worker reads it the same loose way. A strict check
  // here would be the one gate that disagrees with the rest about the same user.
  return !!env.IS_OWNER;
}

export async function readProfile(db: AppDb): Promise<TaxProfile> {
  const raw = await getState(db, PROFILE_KEY);
  if (!raw) return DEFAULT_PROFILE;
  try {
    // Merged over the default rather than trusted whole: a profile written by an older version is
    // missing whatever was added since, and `undefined.group` would take the tax screen down
    // rather than fall back — the same reason settings elsewhere are read this way.
    return { ...DEFAULT_PROFILE, ...(JSON.parse(raw) as Partial<TaxProfile>) };
  } catch {
    return DEFAULT_PROFILE;
  }
}

export async function writeProfile(db: AppDb, p: TaxProfile): Promise<void> {
  // §BIZ-SPLIT — the tax half implies the business half, enforced HERE rather than asked of every
  // reader. A profile with `enabled` and no `business` would accrue tax on income the page does
  // not show, and the two flags would then disagree about whether the user has a business at all.
  await setState(db, PROFILE_KEY, JSON.stringify({ ...p, business: p.business || p.enabled }));
}

// ─── periods ────────────────────────────────────────────────────────────────────────────────────

/** 'YYYY-Qn' for the quarter containing `unix` (Kyiv, §APP_TZ). */
export function quarterLabel(unix: number): string {
  const { y, m } = localParts(unix);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/**
 * The Kyiv window a 'YYYY-Qn' label covers — the inverse of `quarterLabel`.
 *
 * Needed because an obligation stores its period as a LABEL, so anything that wants to ask the
 * ledger about that period has to turn it back into two timestamps. Doing that at the call site
 * is how a second definition of «which quarter is Q3» gets written (§APP_TZ).
 */
export function quarterWindow(period: string): { from: number; to: number } {
  const [ys, qs] = period.split("-Q");
  const y = Number(ys), q = Number(qs);
  return { from: localMidnight(y, q * 3 - 2, 1), to: localMidnight(y, q * 3 + 1, 1) };
}

/**
 * The statutory deadline for one period.
 *
 * ⚠️ NO WEEKEND SHIFT, deliberately. The rule that moves a deadline off a Saturday applies to
 * REPORTING, not uniformly to payment, and the two are easy to conflate. Showing the statutory
 * date means the app can be a day early; modelling the shift wrongly means it is a day late, and
 * only one of those costs a penalty. Stated on the screen rather than hidden here.
 */
export function dueDate(kind: ObligationKind, period: string): string {
  if (period.includes("Q")) {
    const [ys, qs] = period.split("-Q");
    const y = Number(ys), q = Number(qs);
    // First day of the NEXT quarter, as a plain calendar date.
    const nextY = q === 4 ? y + 1 : y;
    const nextM = q === 4 ? 1 : q * 3 + 1;
    if (kind === "social_contribution") {
      // ЄСВ: the 19th of the month following the quarter.
      return ymd(nextY, nextM, 19);
    }
    // ЄП + ВЗ, group 3: 40 calendar days for the declaration, then 10 more to pay — «quarter end
    // + 50 days», which reproduces every published 2026 date (19 Feb, 20 May, 19 Aug, 19 Nov).
    return addDays(ymd(nextY, nextM, 1), -1 + 50);
  }
  // Groups 1–2 pay an ADVANCE: the 20th of the month itself, not of the month after.
  const [ys, ms] = period.split("-");
  return ymd(Number(ys), Number(ms), 20);
}

/**
 * ⚠️ CALENDAR arithmetic, deliberately — not «a Kyiv midnight plus 50 × 86 400 seconds».
 *
 * That is what this function did first, and its own test caught it: Q3 ends on 30 September, and
 * fifty days later is on the far side of the October clock change, so the sum landed at 23:00 of
 * the 18th and the deadline printed as **18 November instead of 19**. A deadline a day early is
 * harmless; the same bug in the other direction is a penalty. A due date is a DATE — it has no
 * time of day to be shifted, so it must never be computed from a duration in seconds (§APP_TZ).
 */
function ymd(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// ─── accrual ────────────────────────────────────────────────────────────────────────────────────

export interface Accrual {
  kind: ObligationKind;
  period: string;
  amount: number;
  due_date: string;
}

/**
 * What the given period accrues, from the rates in force IN that period.
 *
 * The rate is resolved against the period's own start, not against today: re-reading a closed
 * quarter in January must not price it with January's minimum wage (§TAX-RATES, §BUDGET-MEMORY).
 */
export async function accrualsFor(
  db: AppDb, profile: TaxProfile, quarterStart: number,
): Promise<Accrual[]> {
  const out: Accrual[] = [];
  const rates = ratesFor(profile, localYmd(quarterStart));
  const qLabel = quarterLabel(quarterStart);
  const nextQuarter = localQuarterStart(quarterStart, 1);

  if (profile.group === 3) {
    const income = await taxRepo.businessIncome(db, quarterStart, nextQuarter);
    out.push({
      kind: "single_tax", period: qLabel,
      amount: taxOnIncome(income.base_uah, rates.single_income_pct),
      due_date: dueDate("single_tax", qLabel),
    });
    out.push({
      kind: "military_levy", period: qLabel,
      amount: taxOnIncome(income.base_uah, rates.levy_income_pct),
      due_date: dueDate("military_levy", qLabel),
    });
  } else {
    // Groups 1–2 owe the same fixed amount every month whether or not anything came in — which is
    // exactly why an app that only reacts to income would understate a quiet quarter to zero.
    const { y, m: firstMonth } = localParts(quarterStart);
    for (let m = 0; m < 3; m++) {
      // A quarter always starts in month 1, 4, 7 or 10, so `firstMonth + m` cannot leave the year.
      const label = `${y}-${String(firstMonth + m).padStart(2, "0")}`;
      out.push({ kind: "single_tax", period: label, amount: rates.single_monthly, due_date: dueDate("single_tax", label) });
      out.push({ kind: "military_levy", period: label, amount: rates.levy_monthly, due_date: dueDate("military_levy", label) });
    }
  }

  // ЄСВ is quarterly and fixed in every group: three months of the monthly figure.
  out.push({
    kind: "social_contribution", period: qLabel,
    amount: rates.esv_monthly * 3,
    due_date: dueDate("social_contribution", qLabel),
  });

  return out.filter((a) => a.amount > 0);
}

/**
 * Recompute and store the accruals for the recent quarters.
 *
 * `back` quarters rather than «all history»: an open quarter moves with every receipt, the one
 * before it can still be corrected by a late import, and everything older is either paid or
 * deliberately unpaid — and `upsertObligation` refuses to touch a paid row in any case.
 */
export async function refreshObligations(
  db: AppDb, now: number, back = 2,
): Promise<void> {
  const profile = await readProfile(db);
  if (!profile.enabled) return;
  for (let i = back; i >= 0; i--) {
    const qStart = localQuarterStart(now, -i);
    const accruals = await accrualsFor(db, profile, qStart);
    for (const a of accruals) {
      await taxRepo.upsertObligation(db, a.kind, a.period, a.amount, a.due_date);
    }
    // Write, then PRUNE: the refresh has to be able to say what no longer accrues, not only what
    // does. Changing the group changes the shape of the quarter (one quarterly ЄП/ВЗ pair for
    // group 3, three monthly ones for groups 1–2), and an upsert can only ever add the new shape
    // beside the old — which billed one open quarter twice, in the reserve, the one figure the
    // module exists to state. Same for an ЄСВ exemption switched on and a council rate set to 0.
    await taxRepo.pruneObligations(
      db, periodsOfQuarter(qStart), accruals.map((a) => ({ kind: a.kind, period: a.period })),
    );
  }
}

/**
 * Every period label one quarter can own: the quarter itself and its three months.
 *
 * The prune is scoped to these rather than to «everything unpaid», because a refresh only looks at
 * the recent quarters on purpose (see above) — and the unpaid rows outside its reach are the oldest
 * debts, which are exactly the ones that must not quietly disappear.
 */
function periodsOfQuarter(quarterStart: number): string[] {
  const { y, m } = localParts(quarterStart);
  // A quarter always starts in month 1, 4, 7 or 10, so `m + k` never leaves the year.
  return [quarterLabel(quarterStart), `${y}-${String(m).padStart(2, "0")}`,
          `${y}-${String(m + 1).padStart(2, "0")}`, `${y}-${String(m + 2).padStart(2, "0")}`];
}

// ─── the answer ─────────────────────────────────────────────────────────────────────────────────

export type LimitState = "ok" | "projected" | "exceeded";

export interface TaxStatus {
  enabled: boolean;
  profile: TaxProfile;
  /** §TAX-RESERVE — accrued and not yet paid, ₴ minor. The money that is not yours. */
  reserved: number;
  /** The nearest unpaid obligation, if any. */
  next: { id: number; kind: ObligationKind; period: string; amount: number; due_date: string; days_left: number } | null;
  obligations: (taxRepo.Obligation & { overdue: boolean })[];
  limit: {
    used: number;
    limit: number;
    pct: number;
    state: LimitState;
    /** 'YYYY-MM-DD' when the current pace reaches the ceiling, or null when it does not this year. */
    projected_date: string | null;
  };
  quarter: { label: string; income: number; n: number; missing_rate: number };
  /** Receipts whose hryvnia base could not be fixed yet — §TAX-FX. */
  missing_rate: number;
}

export async function taxStatus(db: AppDb, now: number): Promise<TaxStatus> {
  const profile = await readProfile(db);
  const qStart = localQuarterStart(now);
  const quarter = await taxRepo.businessIncome(db, qStart, localQuarterStart(now, 1));

  if (!profile.enabled) {
    // A disabled module still answers, with zeroes and the profile — so the client renders one
    // «turn it on» card instead of branching on a missing response (the same reason every other
    // analytics endpoint answers for an empty account).
    return {
      enabled: false, profile, reserved: 0, next: null, obligations: [],
      limit: { used: 0, limit: 0, pct: 0, state: "ok", projected_date: null },
      quarter: { label: quarterLabel(now), income: 0, n: 0, missing_rate: 0 }, missing_rate: 0,
    };
  }

  const yearStart = localYearStart(now);
  const ytd = await taxRepo.businessIncome(db, yearStart, now);
  const rates = ratesFor(profile, localYmd(now));

  // Everything from the start of the previous year: enough to carry a Q4 that is paid in February,
  // and short enough that the list stays a list rather than an archive.
  const rows = await taxRepo.listObligations(db, `${localParts(yearStart).y - 1}-01`);
  const today = localYmd(now);
  const obligations = rows.map((o) => ({ ...o, overdue: !o.paid_tx_id && o.due_date < today }));
  const reserved = obligations.filter((o) => !o.paid_tx_id).reduce((n, o) => n + o.amount, 0);

  const unpaid = obligations.filter((o) => !o.paid_tx_id).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const head = unpaid[0];
  const next = head
    ? {
        // The id travels with it so the «paid» button does not have to re-find this row in the
        // list by matching on a date — two rows can share a due date (ЄП and ВЗ of one quarter).
        id: head.id,
        kind: head.kind as ObligationKind, period: head.period, amount: head.amount,
        due_date: head.due_date,
        // CALENDAR days between two Kyiv dates, not a duration: both sides are already 'YYYY-MM-DD'
        // in Kyiv, so parsing them as UTC midnights subtracts dates rather than instants. Doing it
        // from the raw timestamp instead would make «2 days left» flip to 1 over an afternoon, and
        // across a DST boundary it would be off by an hour in a quantity measured in days.
        days_left: Math.round(
          (Date.parse(`${head.due_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
        ),
      }
    : null;

  // §TAX-LIMIT — the pace is THIS year's, not a category level (§BUDGET-PACE).
  const daysElapsed = Math.max(1, Math.floor((now - yearStart) / DAY));
  const perDay = ytd.base_uah / daysElapsed;
  const remaining = rates.annual_limit - ytd.base_uah;
  let state: LimitState = "ok";
  let projected: string | null = null;
  if (remaining <= 0) {
    state = "exceeded";
  } else if (perDay > 0) {
    const daysToLimit = Math.ceil(remaining / perDay);
    const hit = now + daysToLimit * DAY;
    // Only a projection that lands inside THIS tax year is a projection: the limit resets in
    // January, so «you will exceed it in March 2028» is not a warning, it is noise.
    if (hit < localYearStart(now, 1)) {
      state = "projected";
      projected = localYmd(hit);
    }
  }

  return {
    enabled: true, profile, reserved, next, obligations,
    limit: {
      used: ytd.base_uah, limit: rates.annual_limit,
      pct: rates.annual_limit > 0 ? Math.round((ytd.base_uah / rates.annual_limit) * 1000) / 10 : 0,
      state, projected_date: projected,
    },
    quarter: { label: quarterLabel(now), income: quarter.base_uah, n: quarter.n, missing_rate: quarter.missing_rate },
    missing_rate: ytd.missing_rate,
  };
}

/**
 * The ФОП block for the adviser's snapshot and for MCP — §TAX-UAH, in whole hryvnia.
 *
 * Lives HERE rather than inside `collectFinanceSnapshot` for two reasons. The mechanical one:
 * `advisor.ts` sits one line under its C3 exception, and an exception may never rise. The real
 * one: this is tax arithmetic, and `advisor.ts` is where advice is composed — a module that
 * already had to be split twice for mixing the two.
 *
 * ⚠️ The note is not decoration. A model handed `tax_reserved_uah` beside `own_funds_uah` will
 * subtract one from the other and call the result the cushion, because that is what the names
 * suggest. It is told, in the payload, that the reserve is ALREADY inside own funds and that
 * runway is deliberately computed without it (§TAX-RESERVE).
 */
/**
 * §FOP-GATE + §TAX-RESERVE — the same context, for a caller that holds an env rather than a db.
 *
 * The adviser and the cash-flow projection mix the ФОП figures into a payload built for everyone,
 * so the gate has to be asked at exactly the point where the two meet. Written here rather than at
 * both call sites: a hidden module that still reasons out loud about a tax reserve is the failure,
 * and it only takes one of the two forgetting to ask.
 */
export async function taxContextFor(
  env: { DB: AppDb; IS_OWNER?: boolean }, now: number,
): Promise<Record<string, unknown>> {
  return fopAvailable(env) ? taxContext(env.DB, now) : {};
}

export async function taxContext(db: AppDb, now: number): Promise<Record<string, unknown>> {
  const profile = await readProfile(db);
  if (!profile.enabled) return {};
  const st = await taxStatus(db, now);
  return {
    fop: {
      group: profile.group,
      // Whole hryvnia, like every other `_uah` field the adviser is given.
      tax_reserved_uah: Math.round(st.reserved / 100),
      next_payment: st.next
        ? { kind: st.next.kind, due: st.next.due_date, days_left: st.next.days_left, amount_uah: Math.round(st.next.amount / 100) }
        : null,
      quarter_income_uah: Math.round(st.quarter.income / 100),
      annual_limit_uah: Math.round(st.limit.limit / 100),
      annual_used_pct: st.limit.pct,
      limit_state: st.limit.state,
      receipts_without_rate: st.missing_rate,
    },
    fop_note:
      "fop is the user's SOLE-TRADER (ФОП) position, and every figure in it is HRYVNIA regardless " +
      "of the currency the other fields use — the state levies in hryvnia. tax_reserved_uah is tax " +
      "that has been ACCRUED and not yet paid: it is money the user still holds, so it is ALREADY " +
      "counted inside own_funds_uah and liquid_cushion_uah — never subtract it from them, and never " +
      "present it as a debt to a bank. Runway and monthly_burn are deliberately computed WITHOUT it, " +
      "because how long the money lasts is a different question from what is owed. limit_state " +
      "'projected' means the current pace crosses the annual ceiling this year; 'exceeded' means it " +
      "already has, which forces a change of group. receipts_without_rate counts foreign-currency " +
      "receipts with no official NBU rate yet — while it is above zero, quarter_income_uah and the " +
      "limit figures are UNDERSTATED, so say so rather than reassuring the user about headroom.",
  };
}
