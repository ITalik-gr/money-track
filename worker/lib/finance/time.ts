/**
 * §APP_TZ — the calendar, in Europe/Kyiv rather than in the runtime's UTC.
 *
 * Split out of `stats.ts` on 2026-08-21. The trigger was its C3 ceiling (an exception may never
 * rise, so an overflow gets a seam), but the seam is the right one on its own: this is time
 * arithmetic, not the money canon, and it is the piece with the widest reach in the project —
 * twenty-seven modules ask it what day it is.
 */
import { tzOffsetSec } from "../../../shared/time.ts";
// The calendar itself lives in shared/ (the client computes the same bounds, UI_PASS F2).
export * from "../../../shared/time.ts";

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