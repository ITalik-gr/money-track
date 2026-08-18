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
import { getLocale } from "../i18n/locale.ts";
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

// Prime at import: an explicit choice, else whatever the language implies — so the first paint,
// which happens before any request comes back, is already in the right unit for this reader.
const saved = storedBaseCurrency();
explicit = saved != null;
current = saved ?? baseCurrencyForLocale(getLocale());
