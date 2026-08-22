/**
 * §BASE-CUR on the client — which currency the numbers on this screen are in.
 *
 * Deliberately the same shape as `i18n/locale.ts`: a module-level value, primed at import, so
 * `baseSign()` can be called from the ~90 places that used to print a literal "₴" without any of
 * them growing a hook or a prop. A React context would have meant threading the currency through
 * every chart tooltip and every legend — the components that are hardest to reach and the ones
 * that mislabel most convincingly.
 *
 * ⚠️ THE CLIENT DOES NOT DECIDE. It states a preference on every request (`x-mt-currency`) and
 * the server answers in the base it could actually honour, returning it on `/rates` — a base with
 * no exchange rate falls back to hryvnia there. Printing "$" over hryvnia numbers is worse than
 * printing "₴", so the sign follows the server's answer, never the request.
 */
import { asBaseCurrency, currencySign, DEFAULT_BASE, type BaseCurrency } from "../../shared/currency.ts";
import { getLocale, onLocaleChange } from "../i18n/locale.ts";
import { baseCurrencyForLocale } from "../../shared/currency.ts";

const STORAGE_KEY = "mt-base-cur";

let current: BaseCurrency = DEFAULT_BASE;
let explicit = false;

/** The user's own choice, if they ever made one. Empty means "follow my language". */
export function storedBaseCurrency(): BaseCurrency | null {
  try {
    return asBaseCurrency(localStorage.getItem(STORAGE_KEY)) ?? null;
  } catch {
    return null;                       // private mode / no storage
  }
}

export function getBaseCurrency(): BaseCurrency {
  return current;
}

/** Has the reader chosen a currency explicitly (as opposed to inheriting one)? */
export function hasStoredBaseCurrency(): boolean {
  return explicit;
}

/** The sign to print next to a rolled-up amount. The one call the render sites make. */
export function baseSign(): string {
  return currencySign(current);
}

/**
 * The sign for a value that MAY be in a currency of its own.
 *
 * `null`/`undefined` means "rolled up", and the whole point of §BASE-CUR is that rolled-up has no
 * fixed currency. Screens used to spell that as `currencySign(cur ?? 980)`, which reads as a
 * harmless default and is in fact the entire bug: one such line on `Stats.tsx` put a ₴ next to
 * every number on all five Statistics tabs, because the sign is threaded down into thirteen
 * blocks from there. Lint C10 now refuses a literal currency code in a sign call.
 */
export function signFor(cur: number | null | undefined): string {
  return cur == null ? baseSign() : currencySign(cur);
}

/**
 * Set the active base. `persist` marks it as an explicit choice; the server-effective base
 * arriving on `/rates` is adopted WITHOUT persisting, so it can never masquerade as a decision
 * the reader made — that distinction is what lets "follow my language" stay reachable.
 */
export function setBaseCurrency(cur: BaseCurrency, persist = true): void {
  current = cur;
  if (!persist) return;
  explicit = true;
  try {
    localStorage.setItem(STORAGE_KEY, String(cur));
  } catch {
    /* ignore */
  }
}

/** Drop the explicit choice and fall back on the language default. */
export function clearBaseCurrency(): void {
  explicit = false;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  current = baseCurrencyForLocale(getLocale());
}

/**
 * The value for `x-mt-currency`, or `null` when this reader has never chosen.
 *
 * ⚠️ **An inherited default must not be sent as a preference.** `resolveBaseCurrency` reads the
 * header FIRST, ahead of the stored setting and ahead of the language — which is right for a
 * choice and wrong for a guess. The client used to state its primed value unconditionally, so a
 * device that had primed to dollars (empty storage → `en` → 840) told the server dollars, got
 * dollars back on `/rates`, and confirmed itself. Sending nothing lets the server answer from
 * what it knows — the saved currency, else the account's language — which is the whole point of
 * the resolution order.
 */
export function currencyHeader(): string | null {
  return explicit ? String(current) : null;
}

// Prime at import: an explicit choice, else whatever the language implies — so the first paint,
// which happens before any request comes back, is already in the right unit for this reader.
const saved = storedBaseCurrency();
explicit = saved != null;
current = saved ?? baseCurrencyForLocale(getLocale());

// …and KEEP following the language, because at import time the language may not be known yet:
// a fresh device (or a Telegram webview, which has storage of its own) primes to `en` and only
// learns the account's real locale a request later. Without this the currency stayed frozen at
// whatever that first guess implied — see `onLocaleChange` for the full report.
// An explicit choice is never overruled: that is what makes it explicit.
onLocaleChange((l) => {
  if (!explicit) current = baseCurrencyForLocale(l);
});
