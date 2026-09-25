import { toBaseMinor, type Rates } from "./money.ts";

/**
 * Розклад і місячний тягар плану — і НІЧОГО більше.
 *
 * ⚠️ Цей файл більше не торкається бази (2026-08-27, лінт C3). Матчинг «яка транзакція є цим
 * планом» переїхав у `plan-match.ts` — це інше питання, і саме воно росло. Реекспорти нижче
 * лишають одне визначення на кожну назву, тож наявні імпорти незмінні.
 */
export {
  type SubRow, type PlanLinkResult,
  nameMatches, planNeedles, planMatches, txHaystack, amountMatches,
  matchActiveSubscription, relatedSubsHint,
  linkPlanHistory, linkPlanHistoryById, applySubscriptionCategories,
} from "./plan-match.ts";
export { type PlannedActual, plannedActuals } from "./plan-actuals.ts";
// §PLAN-STATE: the schedule itself moved to `plan-state.ts` (2026-09-25) so `plan-match` can read
// the cycle window without importing this file back. Re-exported: every existing import stands.
export {
  nextChargeUnix, lastDueUnix, planState, type LinkedCharge, type PlanScheduleLike,
} from "./plan-state.ts";
import { nextChargeUnix } from "./plan-state.ts";

// §CUR-PLAN (2026-07-20): ЄДИНЕ джерело «скільки коштує план у ₴».
// Раніше кожен ендпоінт сумував `period_amount` НАПРЯМУ, ігноруючи `currency_code` —
// підписка $5 рахувалась як 5 ₴ (у «Скоро спишеться», прогнозі, календарі та в
// AI-контексті порадника). Будь-яке зведення планів у ₴ — лише через ці хелпери.
export function plannedUAH(amountMinor: number | null, code: number | null, rates: Rates): number {
  return toBaseMinor(amountMinor ?? 0, code ?? 980, rates);
}

// Сума планів у ₴. Приймає будь-які рядки з сумою+валютою (не лише SubRow).
export function sumPlannedUAH(
  plans: { period_amount: number | null; currency_code?: number | null }[],
  rates: Rates,
): number {
  return plans.reduce((s, p) => s + plannedUAH(p.period_amount, p.currency_code ?? 980, rates), 0);
}

/** Мінімум полів плану, потрібний для розкладу й місячного тягаря. */
export interface PlanLike {
  period_amount: number | null;
  currency_code?: number | null;
  period: string;
  period_count?: number | null;
  start_date: number;
  end_date?: number | null;
  kind?: string | null;
}

/** Скільки тижнів у середньому місяці — щоб тижневий план не важив як місячний. */
const WEEKS_PER_MONTH = 365.25 / 12 / 7;   // ≈ 4.348

/**
 * §SUB-MONTH (2026-08-01) — МІСЯЧНИЙ тягар плану в ₴-копійках. ЄДИНЕ джерело.
 *
 * Що це лікує: «підписок на місяць» рахувалось як `SUM(period_amount)` по всіх активних
 * планах — тобто сума СВОГО періоду в кожного. Квартальна підписка (`period='month'`,
 * `period_count=3`) важила повну суму щомісяця, тижнева — навпаки, лише свій тиждень.
 * Міграція 0011 прямо описує правильну формулу («місячний тягар = period_amount/period_count»),
 * але жоден із пʼяти сумувальників її не застосовував — і в AI-контекст їхала цифра, яку
 * користувач у себе не впізнавав.
 *
 * ⚠️ Це УСЕРЕДНЕНА величина для порівнянь («скільки підписки зʼїдають на місяць»). Для
 * питання «що спишеться до кінця місяця» вона не годиться — там потрібен розклад
 * (`chargesBetween`), бо квартальний платіж або є в цьому місяці, або його немає.
 */
export function monthlyPlannedUAH(p: PlanLike, rates: Rates, now = Math.floor(Date.now() / 1000)): number {
  const amt = plannedUAH(p.period_amount, p.currency_code ?? null, rates);
  if (amt <= 0) return 0;
  if (p.end_date != null && p.end_date <= now) return 0;   // розстрочка добігла кінця
  const n = Math.max(1, Math.round(p.period_count || 1));
  return Math.round((p.period === "week" ? amt * WEEKS_PER_MONTH : amt) / n);
}

export function sumMonthlyPlannedUAH(
  plans: PlanLike[], rates: Rates, now = Math.floor(Date.now() / 1000),
): number {
  return plans.reduce((s, p) => s + monthlyPlannedUAH(p, rates, now), 0);
}

export interface PlannedCharge<T> { plan: T; at: number; amount: number }

/**
 * Розклад списань планів у вікні [from, to] (включно), суми в ₴-копійках.
 *
 * ЄДИНЕ джерело розгортання плану в конкретні дати: той самий цикл жив трьома копіями
 * (cashflow-календар, провал ліквідності у стрічці, прогноз місяця), і кожна мала шанс
 * розійтись у дрібниці — напр. чи враховувати `end_date` розстрочки.
 * `guard` є навмисно: план із зіпсованим `period` інакше крутив би цикл вічно.
 */
export function chargesBetween<T extends PlanLike>(
  plans: T[], rates: Rates, from: number, to: number,
): PlannedCharge<T>[] {
  const out: PlannedCharge<T>[] = [];
  for (const p of plans) {
    const amount = plannedUAH(p.period_amount, p.currency_code ?? null, rates);
    if (amount <= 0) continue;
    let t = nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, from - 1);
    for (let guard = 0; guard < 400 && t <= to; guard++) {
      if (p.end_date != null && t > p.end_date) break;
      out.push({ plan: p, at: t, amount });
      t = nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, t);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

