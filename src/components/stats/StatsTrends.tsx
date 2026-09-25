/**
 * Statistics → Trends: the same money over time.
 *
 * Split out of `src/pages/Stats.tsx` on 2026-08-08. That file was 1 379 lines — the largest in the
 * project — and it had stopped being a page: it was five pages sharing a header. The cut follows
 * the TABS, because that is the boundary the user already sees and the one that decides what is
 * on screen; any other cut would have produced files nobody could name.
 *
 * `Stats.tsx` keeps what all five genuinely share: the period, the currency, the one
 * `/analytics/overview` request they all read. Everything a single tab owns lives here.
 */

import { dateFmt } from "../../i18n/locale.ts";
import type { Overview, CashProjection } from "../../store/api.ts";
import { labelFor } from "./shared.tsx";

/**
 * §1: the running net (income − spend) per bucket, plus §CASH-PROJ — the projected tail.
 *
 * ⚠️ **The forecast is no longer computed here.** It used to be a MEDIAN daily net repeated for
 * every remaining day, which is why the dashed line was always perfectly straight — the owner's
 * report: «предікт просто поступово кожен день знімає скільки в середньому витрачаю, завжди лінія
 * рівно плавно вниз». A median cannot know that rent leaves on the 20th or that the salary lands
 * on the 5th; it is built to discard exactly those, because in a flat model a lump would smear
 * across every day.
 *
 * The server now answers with per-day DELTAS (`/analytics/cash-projection`), built out of the
 * schedule (§SUB-MONTH, §INCOME-PLAN) and the calendar shape of ordinary spending (§WEEKDAY). This
 * function only accumulates them — a second running sum in the client is how a chart's two halves
 * end up disagreeing about the day they meet.
 */
export type CumPoint = {
  label: string;
  cum: number | null;
  proj?: number | null;
  /** Tooltip heading: the full date for a day bucket, the axis label otherwise. */
  title: string;
  /** Actual bucket, whole units of the reader's currency. */
  spend?: number;
  income?: number;
  /** Projected day: named plans (positive leaves), shaped ordinary spend, expected income. */
  plans?: { title: string; amount: number }[];
  ordinary?: number;
  expIncome?: number;
  incomes?: { title: string; amount: number }[];
  payday?: boolean;
};

const dayTitle = dateFmt({ weekday: "short", day: "numeric", month: "short" });

export function toCumulative(series: Overview["series"], projection?: CashProjection | null): CumPoint[] {
  let acc = 0;
  const daily = series.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.bucket));
  const rows: CumPoint[] = series.map((s) => {
    acc += (s.income - s.spend) / 100;
    return {
      label: labelFor(s.bucket),
      title: daily ? dayTitle.format(new Date(s.bucket + "T12:00:00")) : labelFor(s.bucket),
      cum: Math.round(acc), spend: s.spend / 100, income: s.income / 100,
    };
  });
  if (!projection?.days.length || !daily || rows.length < 2) return rows;

  const lastCum = rows[rows.length - 1].cum ?? 0;
  rows[rows.length - 1].proj = lastCum;   // the bridge from the actual line to the dashed one
  let proj = lastCum;
  for (const d of projection.days) {
    proj += (d.income - d.scheduled - d.ordinary) / 100;
    const at = new Date(d.at * 1000);
    rows.push({
      // The same «dd.mm» as the actual half (`labelFor`), from the server's local date — a locale
      // formatter printed «9/30» after «24.09» on an English screen.
      label: labelFor(d.date),
      title: dayTitle.format(at),
      cum: null,
      proj: Math.round(proj),
      // Income plans ride in `items` with a negative sign; they are shown as income, not as plans.
      plans: d.items.filter((it) => it.amount > 0).map((it) => ({ title: it.title, amount: it.amount / 100 })),
      incomes: d.items.filter((it) => it.amount < 0).map((it) => ({ title: it.title, amount: -it.amount / 100 })),
      ordinary: d.ordinary / 100,
      expIncome: d.income / 100,
      payday: d.payday,
    });
  }
  return rows;
}

// Топ-5 найдорожчих днів періоду (з денних бакетів series). Клік — операції того дня.
// Розширює одиничний «найдорожчий день» у Глибшій аналітиці до рейтингу.
