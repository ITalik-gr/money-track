/**
 * §BASE-CUR — the currency every rolled-up number in this app is EXPRESSED in.
 *
 * The canon has always converted a multi-currency ledger into ONE unit before comparing anything
 * (§Інваріанти: `toBaseMinor`/`baseMult`); that unit was hardcoded to the hryvnia. Which is right
 * for the owner and wrong for everyone the English UI was built for: a visitor who reads
 * "146 000" with a ₴ next to it learns nothing about the size of a grocery bill. So the unit
 * became a setting, and this module is the one place that knows which units exist.
 *
 * Deliberately SHORT list. Every entry must be a currency the rate table actually carries
 * (monobank publishes 840/978 against 980); a base with no rate silently converts every foreign
 * amount to zero, which looks like missing data rather than a missing rate.
 *
 * ⚠️ This decides DISPLAY, never storage. Amounts stay INTEGER minor units in the currency the
 * bank reported (`transactions.currency_code`, `original_amount`) — a display setting that
 * rewrote stored money would make the ledger unreconstructable the moment a rate moved.
 */

export const BASE_CURRENCIES = [980, 840, 978] as const;
export type BaseCurrency = (typeof BASE_CURRENCIES)[number];

export const DEFAULT_BASE: BaseCurrency = 980;

interface CurrencyMeta { sign: string; code: string }

// Signs for everything we may have to PRINT, which is wider than what we can convert INTO:
// an account or a transaction can be in any currency the bank reports, and its own row shows
// its own sign. Only `BASE_CURRENCIES` may be selected as the roll-up unit.
export const CURRENCY_META: Record<number, CurrencyMeta> = {
  980: { sign: "₴", code: "UAH" },
  840: { sign: "$", code: "USD" },
  978: { sign: "€", code: "EUR" },
  826: { sign: "£", code: "GBP" },
  985: { sign: "zł", code: "PLN" },
  756: { sign: "₣", code: "CHF" },
  392: { sign: "¥", code: "JPY" },
};

/** Symbol for a numeric ISO-4217 code; unknown codes print the number, never a wrong sign. */
export function currencySign(code: number): string {
  return CURRENCY_META[code]?.sign ?? CURRENCY_META[code]?.code ?? String(code);
}

export function currencyCode(code: number): string {
  return CURRENCY_META[code]?.code ?? String(code);
}

/** Narrow an arbitrary number to a supported base, so an odd value cannot become a fourth one. */
export function asBaseCurrency(n: unknown): BaseCurrency | undefined {
  const v = typeof n === "string" ? Number(n) : n;
  return BASE_CURRENCIES.includes(v as BaseCurrency) ? (v as BaseCurrency) : undefined;
}

/**
 * The base a reader gets when nobody ever chose one.
 *
 * Language is the only signal available at that point, and it is a real one: the English UI
 * exists for people who do not hold hryvnia. An explicit choice always wins over this — see
 * `resolveBaseCurrency` in the worker.
 */
export function baseCurrencyForLocale(locale: "uk" | "en"): BaseCurrency {
  return locale === "en" ? 840 : 980;
}
