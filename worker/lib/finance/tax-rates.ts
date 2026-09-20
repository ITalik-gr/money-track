/**
 * §TAX-RATES — what the state charges, as DATA with an effective date.
 *
 * WHY NOTHING HERE IS A CONSTANT IN A FORMULA. Every single-tax figure in Ukraine is a percentage
 * of one of two state-set numbers — the minimum wage (МЗП) and the subsistence minimum for a
 * working-age person (ПМ) — both of which change on the 1st of January, and with them the single
 * tax for groups 1 and 2, the military levy for groups 1/2/4, the social contribution, and all
 * three annual income limits. A rate written into a calculation would quietly rewrite a quarter
 * that has already been declared the moment the new year's figures landed. Same rule as
 * §BUDGET-MEMORY: a closed period keeps the world as it was when it closed.
 *
 * WHY THE BASIS RATHER THAN THE AMOUNTS. Only МЗП and ПМ are stored; everything else is derived
 * with the multipliers the Tax Code states. Storing the twelve resulting amounts per year would be
 * twelve chances to mistype one, and no way to notice — the derived figures below reproduce the
 * published ones exactly for both years, which is the check that the multipliers are right.
 *
 * Sources and the 2026 table: `docs/TAX.md` §1 and §8.
 */

/** Minor units (копійки) throughout, like every other amount in this project. */
export interface TaxBasis {
  /** 'YYYY-MM-DD' — the first day these figures apply to. */
  effective_from: string;
  /** Мінімальна заробітна плата, ₴ minor. */
  min_wage: number;
  /** Прожитковий мінімум для працездатних осіб, ₴ minor. */
  subsistence: number;
}

/**
 * ⚠️ Add a year by adding a ROW, never by editing one. An edited row changes the past.
 *
 * Verified for 2026 against the tax service and the professional press (docs/TAX.md §8). The 2025
 * row is the same two state figures for that year; every amount derived from it below matches what
 * was actually published in 2025, which is why it is safe to keep for re-deriving a closed period.
 */
const BASIS: TaxBasis[] = [
  { effective_from: "2025-01-01", min_wage: 800_000, subsistence: 302_800 },
  { effective_from: "2026-01-01", min_wage: 864_700, subsistence: 332_800 },
];

// The multipliers, from the Tax Code. Named rather than inlined so the derivation below reads as
// the law does, and so a change in the law is a change in one place.
const ESV_PCT = 22;          // ЄСВ «за себе»: 22% of the minimum wage, monthly
const LEVY_G124_PCT = 10;    // військовий збір, groups 1/2/4: 10% of the minimum wage, monthly
const SINGLE_G1_PCT = 10;    // ЄП group 1: up to 10% of the subsistence minimum, monthly
const SINGLE_G2_PCT = 20;    // ЄП group 2: up to 20% of the minimum wage, monthly
/** Annual income ceilings, in minimum wages: group 1, 2, 3. */
const LIMIT_IN_WAGES: Record<TaxGroup, number> = { 1: 167, 2: 834, 3: 1167 };
/** Group 3 pays percentages of INCOME, not of a state figure — so these are plain law constants. */
const G3_SINGLE_PCT_NO_VAT = 5;
const G3_SINGLE_PCT_VAT = 3;
const G3_LEVY_PCT = 1;

export type TaxGroup = 1 | 2 | 3;

/**
 * The user's own situation. Entered, never guessed: a guessed group produces a confidently wrong
 * number, which is worse than no number at all (docs/TAX.md §7).
 */
export interface TaxProfile {
  /**
   * §BIZ-SPLIT — the BUSINESS half: «I have business income and costs, show me them apart from my
   * personal money». It owns the clients, the costs, the margin and the quarters — everything
   * that is true of a business whether or not the state is involved.
   *
   * Its own switch because the two are genuinely independent (owner, 2026-09-21: «це саме
   * сторінка бізнес, щоб можна було і просто свій бізнес фінанси трекати, а фоп вже це як фіча
   * просто додаткова»). A freelancer without a ФОП, a person between registrations, someone
   * whose ФОП is run by an accountant — all have a business and none of them have a tax module
   * we may compute for.
   */
  business: boolean;
  /**
   * The TAX half (ФОП): the reserve, the obligations, the annual ceiling, the income book.
   *
   * ⚠️ Implies `business` and is never on without it — a tax accrual with no business income to
   * accrue on is a number about nothing. `writeProfile` enforces that so no reader has to.
   */
  enabled: boolean;
  group: TaxGroup;
  /** Group 3 only: a VAT payer pays 3% instead of 5%. */
  vat: boolean;
  /**
   * Groups 1–2 only: the local council sets the rate up to the legal maximum, so a lower one is
   * legitimate. Minor units per month; null means «the maximum», which is what most councils set.
   */
  single_override: number | null;
  /**
   * ЄСВ is mandatory again in 2026 — the blanket wartime exemption is suspended and only the
   * mobilised mechanism (Law 4505) remains. A flag rather than an assumption in either direction:
   * assuming «pays» bills a mobilised person for money they do not owe, and assuming «exempt»
   * hides a real debt (docs/TAX.md §1).
   */
  esv_exempt: boolean;
}

export const DEFAULT_PROFILE: TaxProfile = {
  business: false, enabled: false, group: 3, vat: false, single_override: null, esv_exempt: false,
};

/** The basis in force on a given Kyiv date. */
export function basisFor(ymd: string): TaxBasis {
  let hit = BASIS[0]!;
  for (const b of BASIS) if (b.effective_from <= ymd) hit = b;
  return hit;
}

/** Percent of a minor-unit amount, rounded to the kopeck — never a float result. */
function pct(amount: number, percent: number): number {
  return Math.round((amount * percent) / 100);
}

/**
 * Everything the calculator needs for one date, already resolved against the profile.
 *
 * Returned as one object rather than six functions because these figures are only ever correct
 * TOGETHER: a caller that took the 2026 limit and the 2025 contribution would be wrong in a way
 * no type could catch.
 */
export interface ResolvedRates {
  basis: TaxBasis;
  /** Fixed monthly single tax, groups 1–2; 0 for group 3, which pays on income instead. */
  single_monthly: number;
  /** Fixed monthly military levy, groups 1–2; 0 for group 3. */
  levy_monthly: number;
  /** Monthly social contribution; 0 when exempt. */
  esv_monthly: number;
  /** Group 3: percent of income for the single tax; 0 for groups 1–2. */
  single_income_pct: number;
  /** Group 3: percent of income for the military levy; 0 for groups 1–2. */
  levy_income_pct: number;
  /** Annual income ceiling for the group, ₴ minor. */
  annual_limit: number;
}

export function ratesFor(profile: TaxProfile, ymd: string): ResolvedRates {
  const basis = basisFor(ymd);
  const g3 = profile.group === 3;
  const maxSingle = profile.group === 1
    ? pct(basis.subsistence, SINGLE_G1_PCT)
    : pct(basis.min_wage, SINGLE_G2_PCT);

  return {
    basis,
    // ⚠️ The override is clamped, not trusted. A council rate above the legal maximum is a typo,
    // and a typo that silently raises what the app says you owe is money the user sets aside for
    // nothing — while an over-large number also looks authoritative enough not to be questioned.
    single_monthly: g3 ? 0 : Math.min(profile.single_override ?? maxSingle, maxSingle),
    levy_monthly: g3 ? 0 : pct(basis.min_wage, LEVY_G124_PCT),
    esv_monthly: profile.esv_exempt ? 0 : pct(basis.min_wage, ESV_PCT),
    single_income_pct: g3 ? (profile.vat ? G3_SINGLE_PCT_VAT : G3_SINGLE_PCT_NO_VAT) : 0,
    levy_income_pct: g3 ? G3_LEVY_PCT : 0,
    annual_limit: basis.min_wage * LIMIT_IN_WAGES[profile.group],
  };
}

/** Percent of income, for the group-3 accrual. Exported so the one rounding rule stays shared. */
export function taxOnIncome(incomeMinor: number, percent: number): number {
  return percent > 0 ? pct(incomeMinor, percent) : 0;
}
