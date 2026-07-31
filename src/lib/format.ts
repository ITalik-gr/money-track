// Money is minor units (копійки) everywhere; format only for display.
import { dateFmt, numFmt } from "../i18n/locale.ts";

const CURRENCY: Record<number, { sign: string; code: string }> = {
  980: { sign: "₴", code: "UAH" },
  840: { sign: "$", code: "USD" },
  978: { sign: "€", code: "EUR" },
};

export function currencySign(code: number): string {
  return CURRENCY[code]?.sign ?? CURRENCY[code]?.code ?? String(code);
}

/** minor units -> "1 234,50" (uk grouping). */
export function formatMinor(minor: number, opts?: { decimals?: boolean }): string {
  const decimals = opts?.decimals ?? true;
  const major = minor / 100;
  return numFmt({
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  }).format(major);
}

/** Convert minor units in `code` to UAH minor units via the cached rates map
 *  (currency code → UAH per unit). Returns null if no rate for a non-UAH code. */
export function toUAHMinor(minor: number, code: number, rates: Record<string, number>): number | null {
  if (code === 980) return minor;
  const rate = rates[String(code)];
  return rate ? Math.round(minor * rate) : null;
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

export function startOfMonthUnix(d = new Date()): number {
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
}
