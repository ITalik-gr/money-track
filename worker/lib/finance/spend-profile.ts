/**
 * §SPEND-PROFILE — three questions about the SHAPE of a period that nothing on Statistics asked.
 *
 * The page is thorough about "how much and on what": totals, categories, merchants ranked,
 * weekdays, days of the month, cheque sizes (§SHAPE), importance (§IMPORTANCE-TREND). All of them
 * describe the money. None of them describes the BEHAVIOUR that produced it, and these three do:
 *
 *  • **quiet days** — how many days of the period had no spending at all, and the longest run of
 *    them. Two months with the same total are different months if one of them had eleven days
 *    where nothing was bought and the other had none; the totals cannot say so, and a person
 *    trying to spend less can act on this one directly.
 *  • **concentration** — how FEW merchants make up half the spending. The merchants tab ranks
 *    them and gives each an amount, which answers "who is biggest" and never "how much of my life
 *    is six companies". Those are different facts, and the second one is the one that surprises.
 *  • **new faces** — how much of the period went to merchants never seen BEFORE it. §HABITS
 *    already reports which regular merchants appeared or went quiet, but it counts merchants and
 *    only recurring ones (≥2 of 3 months). This counts MONEY, and it is the difference between a
 *    month spent repeating and a month spent exploring.
 *
 * ⚠️ **One period, one population.** All three run over `SPEND_WHERE` with `STATS_JOINS`, i.e. the
 * same rows the page's own total is built from — so «11 тихих днів» and «6 мерчантів = половина»
 * are about the money printed above them. A private filter here would be a second definition of
 * "spending" one scroll away from the first (§CUR-PLAN, and the reason §SHAPE states the same).
 *
 * ⚠️ **The unit of a merchant is `coreToken`**, the same normalisation §SIMILAR and §SUB-DETECT
 * use. «X Corp.» and «X Corp» are one merchant everywhere or the app groups one way and counts
 * another.
 *
 * ⚠️ **A refund is not a visit.** It passes `SPEND_WHERE` deliberately (§REFUND — it must SUBTRACT
 * from the total), but a day whose only movement was money coming back is not a day of spending,
 * and a merchant is not "new" because it refunded you.
 */
import type { Env } from "../../env.ts";
import { STATS_JOINS, EFF_AMOUNT, SPEND_WHERE } from "./stats.ts";
import { localDayStart, localFmtSql, localYmd } from "./time.ts";
import { coreToken } from "./merchants.ts";
import { toBaseMinor, type Rates } from "./money.ts";
import type { SpendProfile } from "../../../shared/api/insights.ts";

/** Merchants below this share of the period are not worth naming in a concentration sentence. */
const HALF = 0.5;





interface DayRow { day: string; spent: number }
interface MerchRow { merchant: string | null; spent: number; first_seen: number }

export async function spendProfile(
  env: Env, rates: Rates, from: number, to: number, now = Math.floor(Date.now() / 1000),
): Promise<SpendProfile> {
  /**
   * Days are bucketed in APP_TZ (§APP_TZ). In UTC every purchase after 21:00 Kyiv lands on the
   * NEXT day, which here would silently move a quiet day onto a busy one and back — the count
   * would still look entirely reasonable.
   */
  const dayExpr = localFmtSql(now, "%Y-%m-%d");
  const dayRows = await env.DB.prepare(
    `SELECT ${dayExpr} AS day, SUM(-${EFF_AMOUNT}) AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time < ? AND ${SPEND_WHERE} AND ${EFF_AMOUNT} < 0
     GROUP BY day`,
  ).bind(from, to).all<DayRow>();

  /**
   * `first_seen` is the merchant's first charge EVER, not within the window — that is the whole
   * question. A merchant first met inside the window is new; one met two years ago is not, even
   * if it has been quiet since.
   */
  const merchRows = await env.DB.prepare(
    `SELECT t.merchant AS merchant, SUM(-${EFF_AMOUNT}) AS spent,
            (SELECT MIN(p.time) FROM transactions p WHERE p.merchant = t.merchant) AS first_seen
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time < ? AND ${SPEND_WHERE} AND ${EFF_AMOUNT} < 0
       AND t.merchant IS NOT NULL AND TRIM(t.merchant) <> ''
     GROUP BY t.merchant`,
  ).bind(from, to).all<MerchRow>();

  // ---- quiet days -----------------------------------------------------------
  const busy = new Set<string>();
  for (const r of dayRows.results ?? []) if (r.spent > 0) busy.add(r.day);

  const startDay = localDayStart(from);
  const endDay = localDayStart(Math.min(to, now));
  // Whole days only: a window that ends mid-afternoon has no opinion yet about today, and
  // counting it as quiet would report a quiet day every time someone opens the page in the morning.
  const days = Math.max(0, Math.round((endDay - startDay) / 86400));
  let quiet = 0, streak = 0, longest = 0;
  for (let i = 0; i < days; i++) {
    // §APP_TZ: the KEY must be built the same way the SQL bucket was. `localDayStart` returns the
    // unix of local midnight, and reading UTC parts off that lands on the PREVIOUS date in Kyiv
    // (local midnight is 21:00 UTC) — every day would be compared against its neighbour's takings.
    const key = localYmd(localDayStart(startDay, i) + 43200);
    if (busy.has(key)) { streak = 0; continue; }
    quiet++; streak++;
    if (streak > longest) longest = streak;
  }

  // ---- concentration and new faces ------------------------------------------
  // Merchants are folded by `coreToken` first: two spellings of one shop must not be counted as
  // two, or "how few merchants" answers with the app's own untidiness.
  const byToken = new Map<string, { spent: number; first: number }>();
  for (const r of merchRows.results ?? []) {
    const key = coreToken(r.merchant ?? "") || (r.merchant ?? "").trim().toLowerCase();
    if (!key) continue;
    const cur = byToken.get(key);
    if (cur) { cur.spent += r.spent; cur.first = Math.min(cur.first, r.first_seen); }
    else byToken.set(key, { spent: r.spent, first: r.first_seen });
  }

  const merchants = [...byToken.values()].filter((m) => m.spent > 0);
  const total = merchants.reduce((s, m) => s + m.spent, 0);
  const sorted = [...merchants].sort((a, b) => b.spent - a.spent);

  let running = 0, forHalf = 0;
  for (const m of sorted) {
    if (running >= total * HALF) break;
    running += m.spent;
    forHalf++;
  }
  const top5 = sorted.slice(0, 5).reduce((s, m) => s + m.spent, 0);

  const fresh = merchants.filter((m) => m.first >= from);
  const freshSpent = fresh.reduce((s, m) => s + m.spent, 0);

  return {
    from, to,
    total: toBaseMinor(total, 980, rates),
    quiet_days: { quiet, days, longest_streak: longest },
    concentration: {
      merchants_for_half: forHalf,
      merchants: merchants.length,
      top5_share: total > 0 ? round2(top5 / total) : 0,
    },
    new_faces: {
      spent: toBaseMinor(freshSpent, 980, rates),
      merchants: fresh.length,
      share: total > 0 ? round2(freshSpent / total) : 0,
    },
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
