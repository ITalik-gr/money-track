/**
 * §APP_TZ — the calendar, in Europe/Kyiv rather than in the runtime's UTC.
 *
 * Split out of `stats.ts` on 2026-08-21. The trigger was its C3 ceiling (an exception may never
 * rise, so an overflow gets a seam), but the seam is the right one on its own: this is time
 * arithmetic, not the money canon, and it is the piece with the widest reach in the project —
 * twenty-seven modules ask it what day it is.
 */
// ---- Календар рахується в ЛОКАЛЬНІЙ таймзоні, не в UTC ----------------------
//
// Баг, через який це існує (знайдено 2026-08-01 на реальних даних): о 02:46 1 серпня в Києві
// Статистика показувала ЛИПЕНЬ, який би тип періоду не вибрати. Причина — рантайм воркера живе
// в UTC, а `new Date(x).getMonth()/getDate()/getDay()` віддають частини дати саме в зоні
// рантайму. 1 серпня 02:46 у Києві — це ще 31 липня 23:46 в UTC, тож «цей місяць» чесно
// обчислювався як липень. Щоночі з 00:00 до 03:00 застосунок був на добу позаду, і виглядало
// це як «статистика зламалась», а не як «межа періоду в іншій зоні».
//
// ⚠️ Ніколи не бери частини дати з `new Date(...).getMonth()` тощо для меж періоду — тільки
// через хелпери нижче. `Date.UTC` усередині них — це чиста календарна арифметика над уже
// локальними Y/M/D, а не повернення до UTC.
export const APP_TZ = "Europe/Kyiv";

const TZ_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: APP_TZ, hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export interface LocalParts { y: number; m: number; d: number; hh: number; mm: number; ss: number }

/** Частини локальної дати для unix-секунд. */
export function localParts(unix: number): LocalParts {
  const p: Record<string, string> = {};
  for (const part of TZ_FMT.formatToParts(unix * 1000)) p[part.type] = part.value;
  // Деякі версії ICU віддають опівніч як "24" — інакше доба з'їжджала б на добу.
  return { y: +p.year!, m: +p.month!, d: +p.day!, hh: +p.hour! % 24, mm: +p.minute!, ss: +p.second! };
}

/**
 * Unix-секунди локальної півночі заданої локальної дати (місяць/день можуть виходити за межі —
 * `Date.UTC` нормалізує, тож `localMidnight(2026, 0, 1)` = 1 грудня 2025).
 *
 * Дві ітерації, а не одна: щоб дізнатись зсув зони, треба вже мати момент часу, а щоб мати
 * момент — треба зсув. Перший прохід дає зсув «приблизно там», другий сходиться. На переході
 * літнього часу це і розв'язує ±1 год неоднозначність.
 */
export function localMidnight(y: number, m: number, d: number): number {
  return localWallTime(y, m, d);
}

/**
 * Той самий зворотний перерахунок, але для БУДЬ-ЯКОГО настінного часу, не лише опівночі.
 *
 * Потрібен там, де ми ЧИТАЄМО чужу дату: банківська виписка пише київський настінний час без
 * зони, і зібрати з нього момент — це рівно та сама задача, що в `localMidnight`, тільки з
 * годинами. Додати години до локальної півночі не можна: у добу переходу на літній час їх 23
 * або 25, тож саме на цій добі результат зʼїхав би на годину.
 */
export function localWallTime(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number {
  const wanted = Math.floor(Date.UTC(y, m - 1, d, hh, mm, ss) / 1000);
  let ts = wanted;
  for (let i = 0; i < 2; i++) {
    const p = localParts(ts);
    const offset = Math.floor(Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) / 1000) - ts;
    const next = wanted - offset;
    if (next === ts) break;
    ts = next;
  }
  return ts;
}

/** Понеділок 0 … неділя 6 для ЛОКАЛЬНОЇ дати (чиста календарна арифметика). */
function dowMonday0(p: LocalParts): number {
  return (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7;
}

/** Локальна північ дня, у якому лежить `unix` (+ зсув у днях). */
export function localDayStart(unix: number, addDays = 0): number {
  const p = localParts(unix);
  return localMidnight(p.y, p.m, p.d + addDays);
}

/** Локальна північ ПОНЕДІЛКА ISO-тижня, у якому лежить `unix` (+ зсув у тижнях). */
export function localWeekStart(unix: number, addWeeks = 0): number {
  const p = localParts(unix);
  return localMidnight(p.y, p.m, p.d - dowMonday0(p) + addWeeks * 7);
}

/** Локальна північ 1-го числа місяця, у якому лежить `unix` (+ зсув у місяцях). */
export function localMonthStart(unix: number, addMonths = 0): number {
  const p = localParts(unix);
  return localMidnight(p.y, p.m + addMonths, 1);
}

/** Локальна північ 1-го числа кварталу (+ зсув у кварталах). */
export function localQuarterStart(unix: number, addQuarters = 0): number {
  const p = localParts(unix);
  return localMidnight(p.y, Math.floor((p.m - 1) / 3) * 3 + 1 + addQuarters * 3, 1);
}

/** Локальна північ 1 січня (+ зсув у роках). */
export function localYearStart(unix: number, addYears = 0): number {
  return localMidnight(localParts(unix).y + addYears, 1, 1);
}

/** `YYYY-MM` локального місяця — для ключів, які треба зіставляти з місячними рядами. */
export function localYm(unix: number): string {
  const p = localParts(unix);
  return `${p.y}-${String(p.m).padStart(2, "0")}`;
}

/**
 * `YYYY-MM-DD` ЛОКАЛЬНОЇ доби.
 *
 * Той самий §APP_TZ, що й для меж періоду, але для ключів-рядків: `toISOString().slice(0,10)`
 * віддає добу в UTC, тож щоночі з 00:00 до 03:00 за Києвом ключ показував учорашню дату. Для
 * `dedup_key` сповіщень це означало, що подія, згенерована вночі, підписувалась учорашнім днем
 * і зливалась із учорашньою.
 */
export function localYmd(unix: number): string {
  const p = localParts(unix);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Наскільки зона попереду UTC у цей момент, у секундах (+7200 узимку, +10800 влітку). */
export function tzOffsetSec(unix: number): number {
  const p = localParts(unix);
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) / 1000) - unix;
}

/**
 * `strftime('%Y-%m')` у ЛОКАЛЬНІЙ зоні. Потрібне скрізь, де ключі місяців будуються в JS
 * (`localYm`), а групування — в SQL: інакше два боки одного зіставлення жили б у різних зонах.
 *
 * ⚠️ Свідоме спрощення: береться зсув на момент запиту й застосовується до всього вікна. У
 * SQLite немає бази таймзон, тож рядок з іншого боку переходу на літній час може потрапити не
 * в свій місяць — але лише якщо його час припадає на одногодинну смугу біля межі місяця.
 * Було гірше: розбіжність дорівнювала повному зсуву зони (2-3 год) ЗАВЖДИ.
 */
export function localYmSql(now: number, col = "t.time"): string {
  return localFmtSql(now, "%Y-%m", col);
}

/**
 * ANY `strftime` bucket in APP_TZ. Generalised from `localYmSql` on 2026-08-21, when the same
 * defect turned up in the buckets nobody had converted: `series` grouped the main chart with a
 * RAW `strftime`, so on a period whose BOUNDS are Kyiv-local the buckets inside it were UTC —
 * every purchase after 21:00 counted toward the next day, and the first bucket of a calendar
 * month held three hours of the previous one. The drill dimensions had the same split, which is
 * worse: the bar said one number and the list it opened contained a different set of rows.
 */
export function localFmtSql(now: number, fmt: string, col = "t.time"): string {
  return `strftime('${fmt}', ${col} + ${tzOffsetSec(now)}, 'unixepoch')`;
}