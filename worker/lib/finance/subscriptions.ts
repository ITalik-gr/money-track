import { toBaseMinor, type Rates } from "./money.ts";
import { localParts, localWallTime } from "./time.ts";

/**
 * Розклад і місячний тягар плану — і НІЧОГО більше.
 *
 * ⚠️ Цей файл більше не торкається бази (2026-08-27, лінт C3). Матчинг «яка транзакція є цим
 * планом» переїхав у `plan-match.ts` — це інше питання, і саме воно росло. Реекспорти нижче
 * лишають одне визначення на кожну назву, тож наявні імпорти незмінні.
 */
export {
  type SubRow, type PlanLinkResult, type PlannedActual,
  nameMatches, planNeedles, planMatches, txHaystack, amountMatches,
  matchActiveSubscription, relatedSubsHint, plannedActuals,
  linkPlanHistory, linkPlanHistoryById, applySubscriptionCategories,
} from "./plan-match.ts";

// §SUB4 канонічне «наступне списання»: від start_date крокуємо періодом × period_count
// у майбутнє. ЄДИНЕ джерело для воркера (ендпоінти/proactive) — дзеркалиться фронтовим
// Subscriptions.nextCharge. Раніше частина ендпоінтів ігнорувала period_count, тож
// квартальна підписка помилково «спливала» щомісяця.
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

function daysInMonth(y: number, mIndex: number): number {
  return new Date(Date.UTC(y, mIndex + 1, 0)).getUTCDate();
}

export function nextChargeUnix(startDate: number, period: string, count = 1, now = Math.floor(Date.now() / 1000)): number {
  const n = Math.max(1, Math.round(count || 1));
  if (period === "week") { let t = startDate; while (t <= now) t += 7 * 86400 * n; return t; }

  // ⚠️ Every charge is counted from the START, not from the previous one (2026-08-27). The old
  // implementation stepped a `Date` with `setMonth(+1)`, and JavaScript resolves 31 February by
  // ROLLING OVER: a plan starting on the 31st went 31 Jan → 3 Mar → 3 Apr, skipping February
  // outright and then charging on the 3rd for the rest of its life. A subscription whose date
  // quietly moves is worse than one that is late — it lands in a different budget month, and the
  // charge that "disappeared" is the one nobody goes looking for.
  // ⚠️ The anchor is the KYIV day (§APP_TZ): a charge at 01:00 Kyiv on the 20th is the 19th in UTC,
  // and reading it as the 19th would move every schedule a day earlier than the person's calendar.
  const p = localParts(startDate);
  // Start the scan near `now` rather than at the plan's birth: a plan from 2019 would otherwise
  // cost ~80 timezone resolutions per call, and `chargesBetween` calls this in a loop.
  const q = localParts(Math.max(now, startDate));
  let k = Math.max(0, Math.floor((((q.y - p.y) * 12 + (q.m - p.m)) - n) / n) * n);
  for (let guard = 0; guard < 600; guard++, k += n) {
    const mi = (p.m - 1) + k;                       // months since January of the start's year
    const y = p.y + Math.floor(mi / 12);
    const m0 = ((mi % 12) + 12) % 12;               // 0-based, for `daysInMonth`
    // Clamp, never roll over: the 31st of a 30-day month is that month's LAST day, which is what
    // every biller in the world does.
    // `localWallTime` rather than midnight + seconds: on the day the clocks change there are 23 or
    // 25 hours, and adding a time-of-day to midnight moves the charge by one (§APP_TZ).
    const t = localWallTime(y, m0 + 1, Math.min(p.d, daysInMonth(y, m0)), p.hh, p.mm, p.ss);
    if (t > now) return t;
  }
  return startDate;
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

