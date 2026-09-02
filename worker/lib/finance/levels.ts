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
export interface MonthLevel {
  level: number; mean: number; last: number; active_months: number; cv: number; fixed: boolean;
  /**
   * §BURN-SHAPE — is this level a cost that REPEATS, or one lump smeared across the window?
   *
   * See `LUMPY_*` below. Carried on the level rather than derived by callers because burn, the
   * Advisor and the screen must not be able to disagree about which half a category is in.
   */
  lumpy: boolean;
}

/**
 * §BURN-SHAPE (2026-08-27) — a category's level is a LUMP when it is not a monthly cost.
 *
 * Measured on the owner's real data, which is the only reason these two tests are the ones here:
 *   · **one month holds ≥55% of the window** — the SAME share `projectSpend` uses to refuse to
 *     extrapolate a lump, so the two cannot disagree about the same category. It catches the
 *     5 000 ₴ dentist that became «Здоровʼя 1 795/міс», and the April electronics spree that was
 *     still being charged to every future month at 3 507/міс after the category had gone quiet;
 *   · **active in no more than HALF the covered months** — which is what a quarterly ФОП tax
 *     looks like (paid in April and July, 4 253/міс forever in between). It just misses the 55%
 *     test at 50.5%, and it is the single largest lump the owner has.
 *
 * ⚠️ This does NOT change `level`, burn, runway or any budget. A lump is real money and it left
 * the account. What it changes is that the app can now SAY which part of the burn repeats — and
 * «44 784, з них 16 077 разові» is a sentence the owner recognises, where the bare 44 784 was one
 * he did not: «такого і близько немає, можливо колись, але не останні пару місяців».
 */
const LUMPY_MONTH_SHARE = 0.55;

/**
 * §LEVEL-WINDOW — of the month keys given, which ones the LEDGER actually covers.
 *
 * Extracted 2026-08-27 so a second consumer cannot reinvent it. It was written for the category
 * level, but the rule is about denominators in general: any per-month average that divides by the
 * WINDOW rather than by the months that existed understates itself, silently and plausibly.
 * `financeHealth` had the mirror of the same bug (it averaged income over the months that HAD
 * income, so a jobless month made income look more stable), and that is two consumers already.
 *
 * ⚠️ A zero month INSIDE the ledger stays: «I spent nothing on education in April» is real data
 * about a real month. The rule is only about months that did not happen.
 * ⚠️ The ledger's FIRST month counts only if the ledger joined it in its first WEEK. A partial
 * month is exactly what the CURRENT month is excluded for; counting it at the other end is the
 * same defect mirrored.
 */
const FIRST_MONTH_GRACE_DAYS = 7;

/** How many complete months a level is measured over, by default. */
export const LEVEL_WINDOW_MONTHS = 6;

/**
 * The COMPLETE months a level window covers, oldest first, as `YYYY-MM` in `APP_TZ`.
 *
 * Exported because a caller that wants to say "this category was charged in 2 of the 6 months we
 * can see" needs the same denominator the level itself divided by. Building a second list of
 * month keys elsewhere is how §APP_TZ bugs come back: a key built in UTC misses and reads as a
 * zero month. The current month is never in it — it is partial by definition.
 */
export function levelWindowKeys(now: number, months = LEVEL_WINDOW_MONTHS): string[] {
  const keys: string[] = [];
  for (let i = months; i >= 1; i--) keys.push(localYm(localMonthStart(now, -i)));
  return keys;
}

export async function coveredMonths(env: Env, keys: string[]): Promise<string[]> {
  const firstRow = await env.DB.prepare("SELECT MIN(time) AS t FROM transactions").first<{ t: number | null }>();
  const firstFullYm = firstRow?.t == null
    ? null
    : localYm(localMonthStart(firstRow.t, localParts(firstRow.t).d <= FIRST_MONTH_GRACE_DAYS ? 0 : 1));
  // `YYYY-MM` sorts as text, the same comparison §CAT-PARTS uses for the trend's first month.
  const covered = firstFullYm ? keys.filter((k) => k >= firstFullYm) : keys;
  // Fewer than one full month of history: the newest window month, alone. There is no honest
  // average over nothing, and returning nothing would blank burn, runway and every budget.
  return covered.length ? covered : keys.slice(-1);
}

export async function categoryMonthlyLevels(
  env: Env, mult: string, opts: { months?: number; now?: number } = {},
): Promise<Map<number, MonthLevel>> {
  const K = opts.months ?? 6;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const from = localMonthStart(now, -K);
  const monthStart = localMonthStart(now);
  // Ключі й групування МУСЯТЬ бути в одній зоні, інакше `months.get(k)` промахується і місяць
  // мовчки читається як нульовий — тобто рівень категорії просто занижується.
  const keys = levelWindowKeys(now, K);

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
  const winKeys = await coveredMonths(env, keys);

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
    // §BURN-SHAPE. Both tests run on the window as covered, so a category cannot be called lumpy
    // for months that predate the ledger — the same denominator §LEVEL-WINDOW fixed above.
    const windowTotal = series.reduce((s, v) => s + Math.max(0, v), 0);
    const biggestShare = windowTotal > 0 ? Math.max(...series) / windowTotal : 0;
    const lumpy = biggestShare >= LUMPY_MONTH_SHARE || activeMonths * 2 <= winKeys.length;
    out.set(id, {
      level, mean, last, active_months: activeMonths,
      cv: Math.round(cvOf(series.filter((v) => v > 0)) * 100) / 100, fixed, lumpy,
    });
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
        // A confirmed fact with no history behind it is a stated MONTHLY cost («I now pay 3 000 for
        // the metro»), so it is recurring by construction — `lumpy: false`, not a default.
        else if (val > 0) out.set(f.id, { level: Math.round(val), mean: 0, last: 0, active_months: 0, cv: 0, fixed: false, lumpy: false });
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

export interface BurnShape {
  /** Everything, unchanged — `sumLevels`. Runway still divides the cushion by THIS. */
  total: number;
  /** The part that repeats: rent, groceries, subscriptions, utilities. */
  recurring: number;
  /** The part that does not: a quarterly tax, a dentist, a month of electronics. */
  lumpy: number;
}

/**
 * §BURN-SHAPE — the burn, split into the half that repeats and the half that does not.
 *
 * **Measured on the owner's ledger, 2026-08-27:** total 44 784 = 28 707 recurring + 16 077 lumpy
 * (quarterly tax 4 253, electronics 3 507, «Інше» 2 290, health 1 795, education 1 522, and four
 * smaller ones). His four full months average 40 939 and August was running at ~28 155/month —
 * i.e. the RECURRING figure is the one that matches what he recognises as his life, and the total
 * is the one he called impossible.
 *
 * ⚠️ **`total` is still the burn and still the divisor of runway.** A lump is money that left the
 * account, and a runway computed without the tax that arrives every quarter is a lie in the more
 * dangerous direction. What the split buys is the ability to say WHY the figure is what it is.
 * ⚠️ It is one function, not a rule each screen applies, because the Advisor's sentence and the
 * card's number are about the same money — and this project has paid for that lesson repeatedly.
 */
export function burnShape(levels: Map<number, MonthLevel>): BurnShape {
  let recurring = 0, lumpy = 0;
  for (const v of levels.values()) (v.lumpy ? (lumpy += v.level) : (recurring += v.level));
  return { total: recurring + lumpy, recurring, lumpy };
}
