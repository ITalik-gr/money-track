/**
 * §MOMENTUM — which categories have been moving in ONE direction for months.
 *
 * Everything on the Comparison tab compares two windows: this month against last, this period
 * against the one before. §CADENCE already guards that against the obvious lie (a monthly bill
 * landing on the far side of a boundary reads as −92%), but even a truthful two-window delta
 * cannot tell a bad month from a trend. «Кафе +40%» after a birthday and «Кафе +40%» because
 * eating out has been creeping up since May are the same number and completely different news,
 * and only the second one is worth doing anything about.
 *
 * A run of complete months in one direction is the cheapest honest way to tell them apart.
 *
 * ⚠️ **Complete months only, and never the current one.** A month in progress is lower than its
 * neighbours by construction, so including it would report a fresh downward run for every
 * category on the 3rd of the month — an app congratulating everyone, every month, for the
 * calendar. Same reason §MONTH-STACK leaves the partial bar out.
 *
 * ⚠️ **A run needs THREE moves in the same direction** (four months of data). Two is a pair of
 * ordinary months: on real ledgers roughly half of all categories rise twice in a row at some
 * point, and a signal that fires on half the list is decoration.
 *
 * ⚠️ **A move must be big enough to mean something.** Each step has to clear both a percentage
 * (`STEP_PCT`) and a floor in money (`STEP_FLOOR_UAH_MINOR`, converted like §CADENCE's
 * `MOVERS_FLOOR_UAH_MINOR` — a bare literal there was 50 ₴ for the owner and $50 for a dollar
 * reader). Three consecutive 2% drifts are noise that happens to point one way.
 *
 * ⚠️ **The categories are the CANON's** — `EFF_CAT_ID`, rolled up into the parent exactly as every
 * other total on the page. A private grouping here would put a trend on a category whose figure
 * elsewhere is assembled from different rows.
 */
import type { Env } from "../../env.ts";
import { STATS_JOINS, EFF_AMOUNT, EFF_CAT_ID, EFF_CAT_NAME, EFF_CAT_COLOR, SPEND_WHERE } from "./stats.ts";
import { catNameSql } from "./categories-i18n.ts";
import { localMonthStart, localYmSql, localYm } from "./time.ts";
import { resolveLocale } from "../platform/i18n.ts";
import { uahToBaseMinor, toBaseMinor, type Rates } from "./money.ts";
import type { MomentumRow, Momentum } from "../../../shared/api/insights.ts";

/** Complete months examined. Six gives at most five moves — enough for a run of three to stand out. */
const WINDOW_MONTHS = 6;
/** A month must differ from the one before it by this much to count as a move. */
const STEP_PCT = 0.08;
/** …and by at least this, in hryvnia minor units, so a small category cannot trend on pennies. */
const STEP_FLOOR_UAH_MINOR = 20000;   // 200 ₴
/** Moves in one direction before we are willing to call it a direction. */
const MIN_RUN = 3;



interface Row { category_id: number; name: string | null; color: string | null; ym: string; spent: number }

export async function categoryMomentum(
  env: Env, rates: Rates, now = Math.floor(Date.now() / 1000),
): Promise<Momentum> {
  const loc = await resolveLocale(env);
  const from = localMonthStart(now, -WINDOW_MONTHS);
  const to = localMonthStart(now);   // exclusive: the current month is never in it

  const months: string[] = [];
  for (let i = WINDOW_MONTHS; i >= 1; i--) months.push(localYm(localMonthStart(now, -i)));

  const rows = await env.DB.prepare(
    `SELECT ${EFF_CAT_ID} AS category_id, ${catNameSql(loc, EFF_CAT_NAME)} AS name, ${EFF_CAT_COLOR} AS color,
            ${localYmSql(now)} AS ym, SUM(-${EFF_AMOUNT}) AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time < ? AND ${SPEND_WHERE} AND ${EFF_CAT_ID} IS NOT NULL
     GROUP BY ${EFF_CAT_ID}, ym`,
  ).bind(from, to).all<Row>();

  const byCat = new Map<number, { name: string | null; color: string | null; months: Map<string, number> }>();
  for (const r of rows.results ?? []) {
    const e = byCat.get(r.category_id) ?? { name: r.name, color: r.color, months: new Map() };
    e.months.set(r.ym, Math.max(0, r.spent));
    byCat.set(r.category_id, e);
  }

  const floor = uahToBaseMinor(STEP_FLOOR_UAH_MINOR, rates);
  const out: MomentumRow[] = [];

  for (const [id, cat] of byCat) {
    // A month with no charge is a real zero INSIDE the window — the category existed and nothing
    // was spent on it. That is the same reading §LEVEL-WINDOW takes for a quiet month.
    const series = months.map((m) => toBaseMinor(cat.months.get(m) ?? 0, 980, rates));

    // Walk BACKWARDS from the newest complete month: the question is "is this happening now",
    // not "did this ever happen". A run that ended in March is history, not momentum.
    let run = 0;
    let dir: "up" | "down" | null = null;
    for (let i = series.length - 1; i > 0; i--) {
      const cur = series[i]!, prev = series[i - 1]!;
      const diff = cur - prev;
      const moved = Math.abs(diff) >= floor && Math.abs(diff) >= prev * STEP_PCT;
      if (!moved) break;
      const step: "up" | "down" = diff > 0 ? "up" : "down";
      if (dir == null) dir = step;
      else if (dir !== step) break;
      run++;
    }
    if (dir == null || run < MIN_RUN) continue;

    const end = series[series.length - 1]!;
    const start = series[series.length - 1 - run]!;
    out.push({
      category_id: id,
      name: cat.name ?? "",
      color: cat.color,
      direction: dir,
      run,
      series,
      change: end - start,
      change_pct: start > 0 ? Math.round(((end - start) / start) * 100) / 100 : null,
    });
  }

  // Biggest movement first, in money: a 300% run on 40 ₴ is arithmetically dramatic and worth
  // nothing, and putting it above rent would teach the reader to skip the block.
  out.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return { months, rows: out };
}
