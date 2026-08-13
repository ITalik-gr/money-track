// Reading a bank's own strings: money, dates, currency codes (BANKS.md §5, step 2).
//
// Every provider meets the same three problems, and each of them fails QUIETLY when it is solved
// twice: "1 234,56" is not a number, "01.05.2026 21:30" is not an instant, and "UAH" is not the
// 980 this project stores everywhere. A second implementation of any of them does not throw — it
// produces plausible wrong money, which is the one failure mode this codebase is organised around
// (§CUR-PLAN, §REFUND, §APP_TZ).
//
// So they live here, once, above the providers. `csv.ts` was the first caller; PrivatBank will be
// the second, and it must not get to decide these questions again.
import { localWallTime } from "../finance/stats.ts";

/**
 * "-1 234,56" / "1234.56" / "(1 234,56)" → minor units (integer kopecks).
 *
 * Money stays INTEGER everywhere in this project, so the conversion rounds ONCE, here. Parsing to
 * a float and multiplying later is how 1234.56 becomes 123455 kopecks.
 */
export function parseAmountMinor(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  // Accounting notation for negatives.
  const parenthesised = /^\((.*)\)$/.exec(s);
  if (parenthesised) s = `-${parenthesised[1]}`;
  // Strip currency letters, ordinary spaces, non-breaking spaces and thin spaces used as
  // thousand separators by Ukrainian exports.
  s = s.replace(/[\s   ]/g, "").replace(/[^\d.,+-]/g, "");
  if (!s) return null;
  // Decide which of `.` and `,` is the decimal separator: the LAST one that appears, since the
  // other is then a thousands separator ("1.234,56" and "1,234.56" both resolve correctly).
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const decimalPos = Math.max(lastComma, lastDot);
  let intPart = s;
  let fracPart = "";
  if (decimalPos >= 0) {
    intPart = s.slice(0, decimalPos);
    fracPart = s.slice(decimalPos + 1);
    // More than two digits after the separator means it was a thousands separator after all
    // ("1.234" is one thousand two hundred, not 1.23).
    if (!/^\d{1,2}$/.test(fracPart)) {
      intPart = s;
      fracPart = "";
    }
  }
  intPart = intPart.replace(/[.,]/g, "");
  const negative = intPart.startsWith("-");
  const digits = intPart.replace(/[^\d]/g, "");
  if (!digits && !fracPart) return null;
  const minor = Number(digits || "0") * 100 + Number((fracPart + "00").slice(0, 2));
  return negative ? -minor : minor;
}

/**
 * A statement date → unix seconds. Returns `null` rather than guessing when the shape is unknown.
 *
 * ⚠️ **A wall clock with no zone is KYIV time, not UTC** (§APP_TZ). Ukrainian banks — monobank's
 * export, PrivatBank's `DATE_TIME_DAT_OD_TIM_P`, everyone's CSV — write local time with no offset,
 * and the previous version of this parser handed those parts to `Date.UTC`. That stored every row
 * three hours late, which is invisible on a morning purchase and moves an evening one to the NEXT
 * DAY: it lands in the wrong day, the wrong week and sometimes the wrong month, and the totals
 * still add up, so nothing looks broken. Same family as the §APP_TZ bug, on the import path.
 *
 * An explicit offset (`Z`, `+03:00`) is honoured as written — the sender said what it meant, and
 * overriding that with a guess would be the same mistake in the other direction.
 */
export function parseStatementDate(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;

  // Unix seconds, already an instant.
  if (/^\d{9,10}$/.test(s)) return Number(s);

  // ISO with an explicit zone — unambiguous, so no interpretation is needed or wanted.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const ms = Date.parse(s.replace(" ", "T"));
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }

  // dd.mm.yyyy [hh:mm[:ss]] — monobank and PrivatBank exports. Separator may be `.` or `-`
  // (PrivatBank's own API answers with dots and asks for dashes).
  const dotted = /^(\d{2})[.\-/](\d{2})[.\-/](\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (dotted) {
    const [, d, m, y, hh = "0", mm = "0", ss = "0"] = dotted;
    return localWallTime(+y!, +m!, +d!, +hh, +mm, +ss);
  }

  // yyyy-mm-dd [hh:mm[:ss]], no zone — a wall clock like the one above.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (iso) {
    const [, y, m, d, hh = "0", mm = "0", ss = "0"] = iso;
    return localWallTime(+y!, +m!, +d!, +hh, +mm, +ss);
  }
  return null;
}

/**
 * ISO-4217 letters → the numeric code this project stores (`980`, not `"UAH"`).
 *
 * Deliberately a LOOKUP that returns `null` for anything unlisted, never a fallback to 980: a
 * currency we cannot name is not hryvnia, and quietly calling it that would multiply a balance by
 * the exchange rate without anyone asking. The list covers what a Ukrainian account realistically
 * holds or spends in; adding one is a one-line change with no thinking required, which is the
 * point of keeping it in a single place.
 *
 * A number passes through unchanged — feeds that already speak numeric (monobank) share this door
 * with feeds that do not (PrivatBank), so a caller never has to know which kind it is holding.
 */
const CURRENCY_NUMERIC: Record<string, number> = {
  UAH: 980, USD: 840, EUR: 978, GBP: 826, PLN: 985, CHF: 756, CZK: 203, HUF: 348,
  RON: 946, BGN: 975, MDL: 498, GEL: 981, TRY: 949, CAD: 124, AUD: 36, JPY: 392,
  CNY: 156, SEK: 752, NOK: 578, DKK: 208, ILS: 376, AED: 784, KZT: 398, THB: 764,
  EGP: 818, RSD: 941, MKD: 807, ALL: 8, ISK: 352, INR: 356, SGD: 702, HKD: 344,
  MXN: 484, BRL: 986, ZAR: 710, NZD: 554, KRW: 410, VND: 704,
};

export function currencyNumeric(code: string | number | null | undefined): number | null {
  if (code == null) return null;
  if (typeof code === "number") return Number.isFinite(code) ? code : null;
  const s = code.trim().toUpperCase();
  if (!s) return null;
  // Some exports put the numeric code in the same column as the letters.
  if (/^\d{3}$/.test(s)) return Number(s);
  return CURRENCY_NUMERIC[s] ?? null;
}
