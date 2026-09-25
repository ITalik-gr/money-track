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
export function buildWeekdayAnalytics(rows: WeekdayRow[], from: number, to: number, habitRows?: WeekdayRow[]): WeekdayAnalytics {
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

  const result: WeekdayAnalytics = {
    from, to, days,
    busiest: steady.length ? steady.reduce((best, d) => (d.typical > best.typical ? d : best)).dow : null,
    weekend_share_pct: total > 0 ? Math.round((weekend / total) * 100) : null,
  };
  return habitRows ? withHabit(result, habitRows, counts) : result;
}

/**
 * §WEEKDAY-HABIT — «when do I spend» as a HABIT, which is the question the Statistics chart asks.
 *
 * Owner, 2026-09-25: the chart said Sundays are expensive and «weekends eat a noticeable share» —
 * because rent (12 500 ₴) was paid on Sunday the 20th. Flagging the day `lumpy` was not enough: the
 * bar still set the scale and the weekend share still counted the rent. The habit figures leave
 * out (1) everything attached to a plan — a contract's date is not behaviour — and (2) on a lumpy
 * day, the one payment that carries it. Both removals are REPORTED (`planned`, `lumps`, `lump` per
 * day), so the chart can say what it set aside instead of silently shrinking.
 */
function withHabit(base: WeekdayAnalytics, habitRows: WeekdayRow[], counts: number[]): WeekdayAnalytics {
  const byDow = new Map(habitRows.map((r) => [r.dow, r]));
  let lumps = 0;
  const days = base.days.map((d) => {
    const r = byDow.get(d.dow);
    const spent = r?.spent ?? 0;
    const biggest = r?.biggest ?? 0;
    const lumpy = spent > 0 && ((r?.n ?? 0) <= 1 || biggest >= spent * 0.55);
    const lump = lumpy ? Math.min(biggest, spent) : 0;
    lumps += lump;
    const habit = spent - lump;
    return { ...d, habit_typical: counts[d.dow]! > 0 ? Math.round(habit / counts[d.dow]!) : 0, lump };
  });
  const habitTotal = days.reduce((s, d) => s + (d.habit_typical ?? 0) * d.days, 0);
  const habitWeekend = days.filter((d) => d.dow === 0 || d.dow === 6).reduce((s, d) => s + (d.habit_typical ?? 0) * d.days, 0);
  const withSpend = days.filter((d) => (d.habit_typical ?? 0) > 0);
  const unplanned = habitRows.reduce((s, r) => s + r.spent, 0);
  return {
    ...base, days,
    habit: {
      busiest: withSpend.length ? withSpend.reduce((b, d) => ((d.habit_typical ?? 0) > (b.habit_typical ?? 0) ? d : b)).dow : null,
      weekend_share_pct: habitTotal > 0 ? Math.round((habitWeekend / habitTotal) * 100) : null,
      planned: Math.max(0, base.days.reduce((s, d) => s + d.spent, 0) - unplanned),
      lumps,
    },
  };
}


// ---- day of MONTH -----------------------------------------------------------
//
// The same question asked along the other axis, and it lives here for the reason the header
// gives: the calendar shape of spending is one concept, and splitting it across two modules would
// let the two halves acquire different rules about time zones and lumps — which is exactly what
// had already happened. The Trends tab was drawing a day-of-month heat map computed IN THE
// CLIENT, off UTC daily buckets, with raw sums: every evening purchase filed one day late, and
// the 31st looked cheap because a 90-day window contains three of them and three 15ths.

/** `strftime('%d')` in APP_TZ — same trap, same fix, as `localDowSql`. */
export function localDomSql(now: number, col = "t.time"): string {
  return `CAST(strftime('%d', ${col} + ${tzOffsetSec(now)}, 'unixepoch') AS INTEGER)`;
}

/**
 * How many times each day-of-month (1..31) occurred in the window, LOCALLY.
 *
 * The normalisation matters more here than for weekdays: a 90-day window holds three 5ths and
 * either two or three 31sts, and February drops the 30th entirely. Raw sums therefore make the
 * end of the month look cheap in every window that is not a whole number of months — which is
 * every window the period switcher offers.
 */
export function domCounts(from: number, to: number): number[] {
  const counts = new Array(31).fill(0) as number[];
  for (let day = localDayStart(from); day <= to; day = localDayStart(day + 36 * 3600)) {
    counts[localParts(day).d - 1]!++;
  }
  return counts;
}

/** One expense row per day-of-month, straight from `repo/analytics.ts`. */
export interface DomRow { dom: number; spent: number; n: number; biggest: number }

export interface DomSpend {
  dom: number; spent: number; n: number; days: number; typical: number; lumpy: boolean;
}

export interface DomAnalytics {
  from: number; to: number;
  days: DomSpend[];
  /** The steadiest-expensive date, lumps excluded. Rent on the 1st is not a habit. */
  busiest: number | null;
  /** Share of the window's spending that left in the first five days of a month. */
  first_five_share_pct: number | null;
}

export function buildDomAnalytics(rows: DomRow[], from: number, to: number): DomAnalytics {
  const counts = domCounts(from, to);
  const byDom = new Map(rows.map((r) => [r.dom, r]));

  const days: DomSpend[] = counts.map((dayCount, i) => {
    const dom = i + 1;
    const r = byDom.get(dom);
    const spent = r?.spent ?? 0;
    const n = r?.n ?? 0;
    return {
      dom, spent, n, days: dayCount,
      typical: dayCount > 0 ? Math.round(spent / dayCount) : 0,
      lumpy: n <= 1 || (spent > 0 && (r?.biggest ?? 0) >= spent * 0.55),
    };
  });

  const total = days.reduce((sum, d) => sum + d.spent, 0);
  // The first five days: rent, subscriptions and standing charges cluster there, and what is left
  // afterwards is the part a person actually decides about. That is the number worth naming.
  const firstFive = days.slice(0, 5).reduce((sum, d) => sum + d.spent, 0);
  const steady = days.filter((d) => !d.lumpy && d.spent > 0);

  return {
    from, to, days,
    busiest: steady.length ? steady.reduce((best, d) => (d.typical > best.typical ? d : best)).dom : null,
    first_five_share_pct: total > 0 ? Math.round((firstFive / total) * 100) : null,
  };
}
