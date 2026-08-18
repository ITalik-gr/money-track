// Money is minor units (копійки) everywhere; format only for display.
import { dateFmt, numFmt } from "../i18n/locale.ts";
import { baseSign } from "./currency.ts";

// The symbol table moved to `shared/currency.ts` (§BASE-CUR): the worker prints signs too — in
// the deterministic advice and in the notification feed — and two tables would have disagreed
// about a currency exactly where nobody looks.
export { currencySign } from "../../shared/currency.ts";

/** minor units -> "1 234,50" (uk grouping). */
export function formatMinor(minor: number, opts?: { decimals?: boolean }): string {
  const decimals = opts?.decimals ?? true;
  const major = minor / 100;
  return numFmt({
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  }).format(major);
}

/**
 * Convert minor units in `code` into the DISPLAY base, using the map `/rates` returned — which
 * is already expressed in that base and carries its own entry for 980 (§BASE-CUR). Returns null
 * when we have no rate, so the caller can omit the "≈" line rather than print a zero.
 *
 * The `?? (code === 980 ? …)` arm covers the first paint, before `/rates` has answered: an empty
 * map then means "hryvnia, unconverted", which is what the old client did unconditionally.
 */
export function toBaseMinor(minor: number, code: number, rates: Record<string, number>): number | null {
  const rate = rates[String(code)] ?? (code === 980 && !Object.keys(rates).length ? 1 : undefined);
  return rate ? Math.round(minor * rate) : null;
}

/** Amount + the sign of the currency the app is currently rolling up into. */
export function formatBase(minor: number, opts?: { decimals?: boolean }): string {
  return `${formatMinor(minor, opts)} ${baseSign()}`;
}

export function formatDate(unix: number): string {
  return dateFmt({ day: "2-digit", month: "short" }).format(unix * 1000);
}

/** Localized short month name for a 0-based month index (0 = Jan). Replaces the hardcoded
 *  Ukrainian MONTHS arrays that were scattered across chart components — one place, follows
 *  the active locale, so axis labels switch language with everything else. */
export function monthShort(monthIndex0: number): string {
  return dateFmt({ month: "short" }).format(new Date(2021, monthIndex0, 1));
}

/**
 * Localized short weekday name for a SQL `strftime('%w')` index (0 = Sunday), §WEEKDAY.
 *
 * Built from a known date rather than a hardcoded array for the same reason as `monthShort`: a
 * literal list freezes one language, and `check-i18n.mjs` bans constructing `Intl` directly
 * because a module-level formatter also freezes the locale at import time. 2021-08-01 was a
 * Sunday, so adding the index lands on the wanted weekday.
 */
export function weekdayShort(dow: number): string {
  return dateFmt({ weekday: "short" }).format(new Date(2021, 7, 1 + dow));
}

export function startOfMonthUnix(d = new Date()): number {
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
}
