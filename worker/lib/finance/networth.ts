// Net worth over time — assets (cushion + investments) minus debt, at the end of each month.
//
// In `lib/` rather than in the handler because it is RECONSTRUCTION, not transport: we keep no
// history of balances, so each account is walked BACKWARDS from its current own funds through the
// daily deltas. That is domain logic by any reading, and it is also what made the route file the
// largest in the project.
//
// It differs from `capital-trend`, which draws ONE net line: here the BREAKDOWN is needed, and a
// breakdown only exists per account — the sign decides whether an account counts as cushion or as
// debt, so accounts cannot be summed before the reconstruction. cushion/debt/investment are then
// composed by the SAME rule as `fundsBreakdown` (§R3), or "now" on the chart would disagree with
// the adviser.
import type { AppDb } from "../platform/db-shim.ts";
import type { Networth } from "../../../shared/api/analytics.ts";
import type { NotifLocale } from "../../../shared/notif-i18n.ts";
import * as accountsRepo from "../../repo/accounts.ts";
import * as analyticsRepo from "../../repo/analytics.ts";
import { getRates, toUAHMinor, ratesForDays, type Rates } from "./finance.ts";
import { localMonthStart } from "./stats.ts";
import { ownFundsMinor } from "./own-funds.ts";
import { st } from "../platform/i18n.ts";

export async function buildNetworth(db: AppDb, months: number, locale: NotifLocale): Promise<Networth> {
  const rates = await getRates(db);
  const now = Math.floor(Date.now() / 1000);
  const from = localMonthStart(now, -months + 1);

  const accs = await accountsRepo.listForNetWorth(db);
  if (!accs.length) return ({ months, points: [], caveats: [], now: null } satisfies Networth);

  // Денна зміна ПО РАХУНКУ, у валюті рахунку (конвертація — на етапі зведення).
  const daily = await analyticsRepo.dailyNetChangeByAccount(db, from);
  const netByAccDay = new Map<string, number>();
  for (const r of daily) netByAccDay.set(`${r.acc}:${r.day}`, r.net);

  // Поточний власний залишок кожного рахунку (баланс − кредитний ліміт, §Інваріанти).
  const own = new Map<string, number>(accs.map((a) => [a.id, ownFundsMinor(a.balance, a.credit_limit)]));
  const roleOf = (a: typeof accs[number]): "liquid" | "investment" => (a.role === "investment" ? "investment" : "liquid");
  const iso = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

  // Історія ручних балансів (§Історія ручних балансів): ручні/крипто-рахунки не мають tx-дельт,
  // тож без цього назад лишались би плоскими. Крокуємо по зафіксованих зрізах.
  const histByAcc = new Map<string, { at: number; balance: number }[]>();
  // `null` = таблиці ще нема на remote (0026) → деградуємо до плоского, як і раніше.
  for (const r of (await accountsRepo.balanceHistory(db)) ?? []) {
    (histByAcc.get(r.acc) ?? histByAcc.set(r.acc, []).get(r.acc)!).push({ at: r.at, balance: r.balance });
  }
  // Баланс ручного рахунку на момент t: останній зріз ≤ t; до першого зрізу — найраніший відомий
  // (не сьогоднішній, щоб не малювати рух там, де його не знали). null = історії взагалі нема.
  const manualBalanceAt = (accId: string, t: number): number | null => {
    const h = histByAcc.get(accId);
    if (!h || !h.length) return null;
    let val = h[0].balance;
    for (const p of h) { if (p.at <= t) val = p.balance; else break; }
    return val;
  };

  // Дати всіх майбутніх точок рахуємо ЗАЗДАЛЕГІДЬ, щоб одним запитом узяти курси на ці дати
  // (§Історія курсів). Інакше довелось би або бити по базі в циклі, або (як було) міряти
  // минулі залишки сьогоднішнім курсом.
  const todayDay = Math.floor(now / 86400);
  const fromDay = Math.floor(from / 86400);
  const pointDays: { day: number; t: number }[] = [];
  for (let day = todayDay; day >= fromDay; day--) {
    if (new Date(day * 86400 * 1000).getUTCDate() === 1 && day !== todayDay) {
      pointDays.push({ day, t: day * 86400 - 1 });
    }
  }
  // Рівно `months` точок: `months-1` кінців місяця + «зараз». Без обрізки в масив потрапляв
  // ще й кінець місяця ПЕРЕД вікном (13 точок на запит «12 міс»).
  pointDays.splice(months - 1);
  const { byDay, covered } = await ratesForDays(db, [...pointDays.map((p) => iso(p.t)), iso(now)].sort());

  // Зводимо стан рахунків у cushion/debt/investment — правило `fundsBreakdown`.
  const snapshot = (t: number, at: Rates) => {
    let cushion = 0, debt = 0, investment = 0;
    for (const a of accs) {
      // Ручний рахунок з історією — беремо зріз на t; інакше tx-реконструйований `own`.
      const hb = a.is_manual === 1 ? manualBalanceAt(a.id, t) : null;
      const ownMinor = hb != null ? ownFundsMinor(hb, a.credit_limit) : (own.get(a.id) ?? 0);
      const uah = toUAHMinor(ownMinor, a.currency_code, at);
      if (roleOf(a) === "investment") { if (uah > 0) investment += uah; else debt += -uah; }
      else { if (uah >= 0) cushion += uah; else debt += -uah; }
    }
    return {
      t,
      // Місяць точки віддаємо ЯВНО (`YYYY-MM`), бо `t` для кінця місяця = 23:59:59 UTC, і клієнт,
      // форматуючи його в Києві (+3), отримував 1-ше число НАСТУПНОГО місяця: підпис кінця червня
      // ставав «лип.» і збігався з підписом точки «зараз» → дубль категорії на осі X, крива
      // зсунута на місяць, а тултіп поточного місяця показував дані попереднього.
      ym: new Date(t * 1000).toISOString().slice(0, 7),
      cushion: Math.round(cushion), debt: Math.round(debt), investment: Math.round(investment),
      assets: Math.round(cushion + investment),
      net: Math.round(cushion + investment - debt),
    };
  };
  const ratesAt = (t: number) => byDay.get(iso(t)) ?? rates;

  // Ідемо від сьогодні назад, знімаючи денні зміни; точку фіксуємо на кінці кожного місяця.
  const pointAtDay = new Map(pointDays.map((p) => [p.day, p.t]));
  const points: ReturnType<typeof snapshot>[] = [snapshot(now, ratesAt(now))];
  for (let day = todayDay; day >= fromDay; day--) {
    for (const a of accs) {
      const delta = netByAccDay.get(`${a.id}:${day}`);
      if (delta) own.set(a.id, (own.get(a.id) ?? 0) - delta); // назад: прибираємо зміну дня
    }
    // Кінець попереднього місяця = день, перед яким починається новий календарний місяць.
    const t = pointAtDay.get(day);
    if (t != null) points.push(snapshot(t, ratesAt(t)));
  }
  points.reverse();

  const caveats: string[] = [];
  // Кажемо про курс лише коли це справді так: коли історія покриває весь період, попередження
  // було б неправдою в інший бік — воно применшувало б точність, якої ми вже досягли.
  if (!covered) {
    caveats.push(st(locale, "networthRatesCaveat"));
  }
  // Плоскі назад — лише ручні БЕЗ жодного зрізу історії. Ті, що мають історію, тепер крокують.
  const flat = accs.filter((a) => a.is_manual === 1 && !(histByAcc.get(a.id)?.length)).map((a) => a.title ?? a.type ?? a.id);
  if (flat.length) {
    caveats.push(st(locale, "networthFlatCaveat", { accounts: flat.join(", ") }));
  }

  return ({ months, points, now: points[points.length - 1] ?? null, caveats } satisfies Networth);
}
