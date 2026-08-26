/**
 * The canonical MONTHLY LEVEL of a category, and the burn that is built out of it.
 *
 * Lifted out of `stats.ts` on 2026-08-27 under lint C3 — the same move `budgetStatus` made on
 * 2026-08-12 and `savingsRatePct` on 2026-08-21. `stats.ts` stays the SQL canon (what a spend IS,
 * how it rolls up, how it converts); a level is judgement ABOUT that canon over a window, which is
 * a different job and the one that keeps growing. Everything is re-exported from `stats.ts`, so no
 * import list changed and there is still exactly one definition.
 *
 * Why one level exists at all: screens each used to compute their own "per month" — a 6-month
 * mean here, `90d ÷ 3` there, the last payment somewhere else — and after a rent rise they all
 * disagreed. One level, read by Patterns (`usual`), budgets, the Advisor, the feed and the burn.
 */
import type { Env } from "../../env.ts";
import {
  STATS_JOINS, SPEND_WHERE, EFF_CAT_ID, amountSum,
} from "./stats.ts";
import { localMonthStart, localYm, localYmSql, localParts } from "./time.ts";

// ---- Канонічний «місячний рівень» категорії (ЄДИНЕ джерело) -----------------
// Проблема: різні екрани рахували «місячну» суму по різних вікнах — 6-міс середнє /
// 90д÷3 / останній платіж. Після стрибка ціни fixed-косту (орендодавець підняв ставку)
// вони не збігались. Тут — один рівень на категорію, узгоджений скрізь:
//   • fixed-кост (регулярний, СТАБІЛЬНИЙ — низький CV, як рента/підписка): рівень = ОСТАННІЙ
//     повний місяць (ловить стрибок ціни, бо середнє відстає);
//   • змінна категорія (продукти/розваги — високий CV): рівень = середнє за вікно (згладжене).
// Рахуємо лише по ПОВНИХ місяцях (поточний частковий виключено). Зведено в ₴ (mult).
export interface MonthLevel { level: number; mean: number; last: number; active_months: number; cv: number; fixed: boolean }
export async function categoryMonthlyLevels(
  env: Env, mult: string, opts: { months?: number; now?: number } = {},
): Promise<Map<number, MonthLevel>> {
  const K = opts.months ?? 6;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const from = localMonthStart(now, -K);
  const monthStart = localMonthStart(now);
  // Ключі й групування МУСЯТЬ бути в одній зоні, інакше `months.get(k)` промахується і місяць
  // мовчки читається як нульовий — тобто рівень категорії просто занижується.
  const keys: string[] = [];
  for (let i = K; i >= 1; i--) keys.push(localYm(localMonthStart(now, -i)));

  /**
   * §LEVEL-WINDOW (2026-08-27) — the denominator is the months the LEDGER covers, not the window.
   *
   * `mean` divided by `K` unconditionally, so every month before the user's first transaction
   * counted as a month in which they spent nothing on this category. On the owner's real data the
   * ledger starts in April and the window is February–July: two of the six months never existed,
   * and EVERY category level was therefore 1.5× too low. Verified figures — «Комуналка» levelled at
   * 1 087 against real months of 1 246 / 1 285 / 2 531 / 1 458, i.e. a level it had never once
   * achieved; the auto-budget then set the limit AT that level and the app reported the envelope
   * 153% over, every month, for a target that was arithmetically unreachable.
   *
   * It runs deeper than one screen: `sumLevels` IS the canonical monthly burn, so runway — the
   * single number that matters most to someone out of work — was systematically optimistic.
   *
   * ⚠️ A zero month INSIDE the ledger stays in the denominator: «I spent nothing on education in
   * April» is real data about a real month, and dividing by active months only would report a
   * yearly insurance payment as a monthly cost. The rule is about months that did not happen, and
   * §CAT-PARTS already states it for the trend chart («нуль до неї — це "акаунта ще не було"»).
   * ⚠️ The ledger's FIRST month counts only if the ledger joined it in its first WEEK. A partial
   * month is exactly what the CURRENT month is excluded for; including it at the other end is the
   * same defect mirrored, and it drags the level down for anyone who started mid-month. The
   * threshold is a judgement: a ledger opened on the 3rd saw essentially all of that month and
   * dropping it would throw away real data, one opened on the 25th saw six days of it.
   */
  const FIRST_MONTH_GRACE_DAYS = 7;
  const firstRow = await env.DB.prepare("SELECT MIN(time) AS t FROM transactions").first<{ t: number | null }>();
  const firstFullYm = firstRow?.t == null
    ? null
    : localYm(localMonthStart(firstRow.t, localParts(firstRow.t).d <= FIRST_MONTH_GRACE_DAYS ? 0 : 1));
  // `YYYY-MM` sorts as text, the same comparison §CAT-PARTS uses for the trend's first month.
  const covered = firstFullYm ? keys.filter((k) => k >= firstFullYm) : keys;
  // Fewer than one full month of history: the newest window month, alone. There is no honest
  // average over nothing, and returning no level at all would blank burn, runway and every budget.
  const winKeys = covered.length ? covered : keys.slice(-1);

  const rows = await env.DB.prepare(
    `SELECT ${EFF_CAT_ID} AS id, ${localYmSql(now)} AS m, ${amountSum(mult)} AS spent
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time < ? AND ${SPEND_WHERE}
     GROUP BY ${EFF_CAT_ID}, m`,
  ).bind(from, monthStart).all<{ id: number | null; m: string; spent: number }>();

  const byCat = new Map<number, Map<string, number>>();
  for (const r of rows.results ?? []) {
    if (r.id == null) continue;
    (byCat.get(r.id) ?? byCat.set(r.id, new Map()).get(r.id)!).set(r.m, r.spent);
  }

  const cvOf = (arr: number[]): number => {
    if (!arr.length) return 0;
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    if (m <= 0) return 0;
    const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
    return Math.sqrt(v) / m;
  };

  const out = new Map<number, MonthLevel>();
  for (const [id, months] of byCat) {
    const series = winKeys.map((k) => months.get(k) ?? 0);
    const mean = Math.round(series.reduce((s, v) => s + v, 0) / winKeys.length);
    const last = series[series.length - 1] ?? 0;
    const activeMonths = series.filter((v) => v > 0).length;
    // Fixed-кост розпізнаємо за СТАБІЛЬНІСТЮ ОСТАННІХ місяців, а не всього вікна: рента/підписка —
    // останні платежі майже однакові (CV≈0), тож рівень = їх середнє (ловить стрибок ціни). Змінні
    // категорії (продукти/розваги) мають розкид навіть недавно → рівень = середнє за все вікно
    // (не хапаємо випадковий пік останнього місяця). Крок ренти визнається за 2-3 міс нового рівня.
    const recentNz = series.slice(-3).filter((v) => v > 0);
    const fixed = recentNz.length >= 2 && cvOf(recentNz) <= 0.12;
    // §REFUND: місяць може вийти ВІД'ЄМНИМ (повернення перевищило витрати — напр. скасували
    // велику покупку минулого місяця). Рівень «мінус 400 ₴/міс» безглуздий і тягнув би burn
    // униз, тож підлога 0.
    const level = Math.max(0, fixed ? Math.round(recentNz.reduce((s, v) => s + v, 0) / recentNz.length) : mean);
    out.set(id, { level, mean, last, active_months: activeMonths, cv: Math.round(cvOf(series.filter((v) => v > 0)) * 100) / 100, fixed });
  }

  // §A1: коригування рівня ПІДТВЕРДЖЕНИМИ фактами (шар фактів). Тут — ЄДИНЕ місце,
  // де факт рухає число (не в ендпоінті), тож burn/runway/Патерни/чат лишаються узгодженими.
  // Лише confirmed_at IS NOT NULL і активний на `now`. multiplier масштабує рівень
  // (метро 8→30 = ×3.75), delta_minor додає копійки/міс (±). Обидва — в ₴-мінор, як level.
  await applyFactAdjustments(env, out, now);
  return out;
}

async function applyFactAdjustments(env: Env, out: Map<number, MonthLevel>, now: number): Promise<void> {
  try {
    // §BASE-CUR: `level` is in the reader's base, `delta_minor` is stored in hryvnia (the facts
    // table has no currency column). A raw addition would add 3 000 dollars to a dollar level.
    // A multiplier is unitless and needs no conversion — which is exactly why it must not be
    // converted either.
    const { getRates, uahToBase } = await import("./money.ts");
    const uah = uahToBase(await getRates(env));
    const rows = await env.DB.prepare(
      `SELECT category_id AS id, adjust_kind AS kind, adjust_value AS val
       FROM facts
       WHERE confirmed_at IS NOT NULL AND category_id IS NOT NULL
         AND adjust_kind IS NOT NULL AND adjust_value IS NOT NULL
         AND effective_from <= ? AND (expires_at IS NULL OR expires_at > ?)`,
    ).bind(now, now).all<{ id: number; kind: string; val: number }>();
    for (const f of rows.results ?? []) {
      const cur = out.get(f.id);
      if (f.kind === "multiplier") {
        if (cur) cur.level = Math.round(cur.level * f.val); // 0×val=0 → категорію без історії не чіпаємо
      } else if (f.kind === "delta_minor") {
        const val = f.val * uah;
        if (cur) cur.level = Math.round(cur.level + val);
        else if (val > 0) out.set(f.id, { level: Math.round(val), mean: 0, last: 0, active_months: 0, cv: 0, fixed: false });
      }
    }
  } catch {
    // Таблиця facts може ще не бути на remote (міграція 0020) — не валимо канонічну статистику.
  }
}

// Канонічний МІСЯЧНИЙ BURN (₴-мінор) = сума місячних рівнів усіх категорій (ЄДИНЕ джерело).
// Замінив «витрати_90д ÷ 3» у пораднику/бюджетах: узгоджено з Патернами (`usual`) й уникає
// роздування разовими лумпами (податок/лікар) — рівень категорії їх усереднює/виключає.
// Runway = ліквідна подушка ÷ цей burn. Бере готову мапу categoryMonthlyLevels (без зайвого запиту).
export function sumLevels(levels: Map<number, MonthLevel>): number {
  let s = 0;
  for (const v of levels.values()) s += v.level;
  return s;
}
