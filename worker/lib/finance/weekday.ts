// §WEEKDAY — "when does the money actually go", as a domain module.
//
// It lives in `lib/finance/` rather than in the route because the numbers here are CANON: the
// screen and the AI context must read one "typical Friday", not compute it twice. That is the
// same reason `plannedUAH` and `categoryMonthlyLevels` are here — the moment a figure exists in
// two places it has two definitions, which is the defect this whole codebase is organised against.
import { localDayStart, localParts, tzOffsetSec } from "./stats.ts";
import type { WeekdayAnalytics, WeekdaySpend } from "../../../shared/api/analytics.ts";

/**
 * `strftime('%w')` (0=неділя … 6=субота) у ЛОКАЛЬНІЙ зоні — §WEEKDAY.
 *
 * Та сама пастка, що в `localYmSql`, але дорожча: доба зсунута на 2-3 год означає, що КОЖНА
 * операція після 21:00 їде в наступний день тижня. Вечір пʼятниці — найгустіший час витрат у
 * реальних даних, і в UTC він рахувався б суботою. Тобто без цього хелпера статистика «за днями
 * тижня» не просто неточна — вона систематично зсунута рівно там, де на неї дивляться.
 *
 * ⚠️ Те саме свідоме спрощення, що й у `localYmSql`: зсув береться на момент запиту.
 */
export function localDowSql(now: number, col = "t.time"): string {
  return `CAST(strftime('%w', ${col} + ${tzOffsetSec(now)}, 'unixepoch') AS INTEGER)`;
}

/**
 * Скільки разів кожен день тижня трапився у вікні [from, to] — ЛОКАЛЬНО (§WEEKDAY).
 *
 * Без цього порівняння днів тижня бреше: у типовому місяці пʼятниць 5, а субот 4, тож «субота
 * дешевша» може означати лише «субот було менше». Ділення на цю кількість і робить число
 * зіставним — «типова субота», а не «сума всіх субот».
 *
 * Індекс масиву = `strftime('%w')`: 0 — неділя.
 */
export function weekdayCounts(from: number, to: number): number[] {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  // Ідемо по ЛОКАЛЬНИХ північах, а не крокуємо по 86400 с: на переході літнього часу доба
  // триває 23 або 25 годин, і фіксований крок з'їхав би на годину, а згодом і на цілу добу.
  for (let day = localDayStart(from); day <= to; day = localDayStart(day + 36 * 3600)) {
    const p = localParts(day);
    counts[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]!++;
  }
  return counts;
}

/** One expense row per weekday, straight from `repo/analytics.ts`. */
export interface WeekdayRow { dow: number; spent: number; n: number; biggest: number }

/**
 * Assemble the response: a typical day per weekday, the priciest STEADY day, and the weekend share.
 *
 * Two judgements are encoded here, and both are the difference between a useful chart and a
 * misleading one:
 *
 *  1. **Divide by how many such days the window held.** A month has five Fridays and four
 *     Saturdays; comparing raw sums would report that difference as behaviour.
 *  2. **A day carried by ONE payment is not a day.** Rent landing on a Sunday does not make
 *     Sundays expensive — it makes Sunday the day rent is due. Same 55% threshold `projectSpend`
 *     uses, so "lumpy" means the same thing in both places.
 */
export function buildWeekdayAnalytics(rows: WeekdayRow[], from: number, to: number): WeekdayAnalytics {
  const counts = weekdayCounts(from, to);
  const byDow = new Map(rows.map((r) => [r.dow, r]));

  const days: WeekdaySpend[] = counts.map((dayCount, dow) => {
    const r = byDow.get(dow);
    const spent = r?.spent ?? 0;
    const n = r?.n ?? 0;
    return {
      dow, spent, n, days: dayCount,
      // Нуль днів можливий лише на дуже короткому вікні — ділити на нього не можна.
      typical: dayCount > 0 ? Math.round(spent / dayCount) : 0,
      lumpy: n <= 1 || (spent > 0 && (r?.biggest ?? 0) >= spent * 0.55),
    };
  });

  const total = days.reduce((sum, d) => sum + d.spent, 0);
  const weekend = days.filter((d) => d.dow === 0 || d.dow === 6).reduce((sum, d) => sum + d.spent, 0);
  const steady = days.filter((d) => !d.lumpy && d.spent > 0);

  return {
    from, to, days,
    busiest: steady.length ? steady.reduce((best, d) => (d.typical > best.typical ? d : best)).dow : null,
    weekend_share_pct: total > 0 ? Math.round((weekend / total) * 100) : null,
  };
}
