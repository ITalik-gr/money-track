import type { BusinessOverview, TaxStatus } from "../../store/api.ts";

/**
 * A fictional business, for judging the screen when there is no real one behind it.
 *
 * Asked for by the owner (2026-09-21: «в мене фопа зараз немає, але якось щоб потестити норм»).
 * The alternative — seeding demonstration rows into the real ledger — was rejected outright: this
 * page reports money, and a synthetic receipt that survives the demonstration is a wrong figure in
 * a tax export. So the sample lives ONLY in the client, is built here and never written anywhere,
 * and the page states in a banner that nothing on it is real.
 *
 * ⚠️ It is deliberately NOT a tidy business. Every state the screen can render is present exactly
 * once — an overdue payment, a ceiling the pace will cross, a client who went quiet, a receipt
 * with no NBU rate, a loss-making month — because a fixture where everything is fine tests only
 * the one layout nobody worries about.
 *
 * ⚠️ Kept in sync by the TYPES, not by discipline: it is `TaxStatus` / `BusinessOverview`, so a
 * field added to either breaks this file rather than quietly leaving the sample a version behind.
 */

const UAH = (whole: number) => Math.round(whole * 100);

/** Days from today, as the unix second the components expect. */
const daysAgo = (n: number) => Math.floor(Date.now() / 1000) - n * 86_400;

/** 'YYYY-MM-DD' n days from today — the format every date field on this page carries. */
function ymd(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM' for n months back, oldest first when mapped over a range. */
function ym(back: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function quarterLabels(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i * 3, 1);
    out.push(`${m.getFullYear()}-Q${Math.floor(m.getMonth() / 3) + 1}`);
  }
  return out;
}

export function sampleStatus(): TaxStatus {
  const labels = quarterLabels(1);
  return {
    enabled: true,
    profile: { business: true, enabled: true, group: 3, vat: false, single_override: null, esv_exempt: false },
    reserved: UAH(18_430),
    // Overdue on purpose: «four days ago» is the single most useful sentence this page produces,
    // and it is the state a fixture of a well-run business would never show.
    next: {
      id: -1, kind: "single_tax", period: labels[0]!, amount: UAH(12_250),
      due_date: ymd(-4), days_left: -4,
    },
    obligations: [
      { id: -1, kind: "single_tax", period: labels[0]!, amount: UAH(12_250), due_date: ymd(-4), paid_tx_id: null, paid_at: null, overdue: true },
      { id: -2, kind: "military_levy", period: labels[0]!, amount: UAH(2_450), due_date: ymd(-4), paid_tx_id: null, paid_at: null, overdue: true },
      { id: -3, kind: "social_contribution", period: labels[0]!, amount: UAH(3_730), due_date: ymd(17), paid_tx_id: null, paid_at: null, overdue: false },
      { id: -4, kind: "single_tax", period: "prev", amount: UAH(11_100), due_date: ymd(-92), paid_tx_id: "sample-tx", paid_at: daysAgo(90), overdue: false },
    ],
    limit: {
      used: UAH(1_910_000), limit: UAH(2_700_000), pct: 71,
      state: "projected", projected_date: ymd(63),
    },
    quarter: { label: labels[0]!, income: UAH(612_000), n: 9, missing_rate: 2 },
    missing_rate: 2,
  };
}

export function sampleBusiness(): BusinessOverview {
  const labels = quarterLabels(6);
  const income = [UAH(380_000), UAH(455_000), UAH(410_000), UAH(520_000), UAH(498_000), UAH(612_000)];
  const costs = [UAH(52_000), UAH(61_000), UAH(58_000), UAH(74_000), UAH(96_000), UAH(81_000)];
  const tax = [UAH(26_600), UAH(31_850), UAH(28_700), UAH(36_400), UAH(34_860), UAH(42_840)];

  return {
    quarters: labels.map((label, i) => ({
      label,
      income: income[i]!,
      tax: tax[i]!,
      expenses: costs[i]!,
      net: income[i]! - costs[i]! - tax[i]!,
      effective_pct: Math.round((tax[i]! / income[i]!) * 1000) / 10,
      fixed: UAH(3_730),
    })),
    // Twelve months, one of them in the red: a business page that cannot render a bad month is a
    // page nobody has looked at on a bad month.
    months: Array.from({ length: 12 }, (_, i) => {
      const back = 11 - i;
      const base = 120_000 + ((i * 37) % 9) * 9_000;
      return {
        ym: ym(back),
        income: UAH(back === 4 ? 21_000 : base),
        costs: UAH(back === 4 ? 46_000 : 14_000 + ((i * 53) % 7) * 3_000),
      };
    }),
    outlook: {
      label: labels.at(-1)!,
      income_so_far: UAH(612_000),
      projected_income: UAH(845_000),
      accrued_now: UAH(42_840),
      projected_tax: UAH(54_580),
      days_elapsed: 62,
      days_left: 29,
      groups: [
        { group: 1, tax: UAH(1_150), esv: UAH(5_600), total: UAH(6_750), annual_limit: UAH(1_444_049), over_limit: true },
        { group: 2, tax: UAH(9_320), esv: UAH(5_600), total: UAH(14_920), annual_limit: UAH(7_818_900), over_limit: false },
        { group: 3, tax: UAH(36_720), esv: UAH(5_600), total: UAH(42_320), annual_limit: UAH(10_925_400), over_limit: false },
      ],
    },
    counterparties: [
      { name: "Northwind Studio", total_uah: UAH(305_000), n: 3, first_at: daysAgo(400), last_at: daysAgo(12) },
      { name: "Kyivsoft LLC", total_uah: UAH(186_000), n: 3, first_at: daysAgo(300), last_at: daysAgo(26) },
      { name: "Marta Bohun", total_uah: UAH(74_000), n: 2, first_at: daysAgo(150), last_at: daysAgo(41) },
      { name: "Lume Agency", total_uah: UAH(47_000), n: 1, first_at: daysAgo(58), last_at: daysAgo(58) },
    ],
    quiet: [
      { name: "Kyivsoft LLC", days_since_last: 26, median_gap_days: 14, avg_uah: 62_000, n: 8 },
    ],
    costs: [
      { category_id: 31, name: "Софт і хмара", uah: UAH(34_000), n: 11 },
      { category_id: 12, name: "Підряд", uah: UAH(28_000), n: 3 },
      { category_id: 44, name: "Обладнання", uah: UAH(12_400), n: 2 },
      { category_id: 21, name: "Звʼязок", uah: UAH(6_600), n: 6 },
    ],
    cash_gap: { due_date: ymd(17), amount: UAH(3_730), expected_income: ymd(24), days_short: 7 },
    rhythm: { n: 9, median_gap_days: 13, days_since_last: 12, avg_uah: 68_000 },
    year_ago: { label: labels[2]!, income: UAH(410_000) },
    top_share_pct: 49.8,
    share_pct: 73.4,
  };
}
