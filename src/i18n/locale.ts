// Locale as a system parameter (PLATFORM.md §12). This file is the SINGLE place allowed to
// hold the raw BCP-47 tags ("uk-UA"/"en-US"); everywhere else must go through `localeTag()`.
// The i18n lint (scripts/check-i18n.mjs) enforces that — a hardcoded "uk-UA" in a component
// would silently keep dates/numbers Ukrainian after the user switched to English, and tsc
// can't see a string literal. Check > instruction.

export type Locale = "uk" | "en";

const STORAGE_KEY = "mt-locale";

// Module-level current locale so the non-React format helpers (formatMinor, formatDate…) can
// stay their current call signatures — `formatMinor(x)` keeps working and simply reads the
// locale set here. Changing their signatures would touch hundreds of call sites for no gain.
let current: Locale = "en";

// The one mapping that is allowed to name the BCP-47 tags. Intl.* callers pass
// `localeTag(getLocale())`, never a literal.
export function localeTag(l: Locale = current): string {
  return l === "uk" ? "uk-UA" : "en-US";
}

export function getLocale(): Locale {
  return current;
}

/** Resolve the boot locale: explicit user choice (localStorage) wins; otherwise English —
 *  the landing page is the portfolio's first impression and must not flip to Ukrainian just
 *  because a visitor's browser reports `uk`. The owner's own preference survives across visits
 *  via localStorage / server sync (`LocaleProvider`), not via browser-language sniffing. */
export function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "uk" || saved === "en") return saved;
  } catch {
    /* ignore — private mode / no storage */
  }
  return "en";
}

/** Whether the user has made an explicit choice yet. Used so a fresh device can adopt the
 *  server-saved preference instead of overriding it with the browser default. */
export function hasStoredLocale(): boolean {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "uk" || saved === "en";
  } catch {
    return false;
  }
}

/** Set the active locale. `persist` controls whether this is treated as an explicit user
 *  choice (written to localStorage). Server sync is done by the React provider, not here,
 *  to keep this module free of network concerns. */
export function setLocale(l: Locale, persist = true): void {
  const changed = current !== l;
  current = l;
  // After `current`, before the write: a listener asking `getLocale()` must see the new value.
  if (changed) for (const fn of localeListeners) fn(l);
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }
}

// Prime the module value at import time so format helpers used before the provider mounts
// still pick the right locale.
current = initialLocale();

/**
 * Notify anything that DERIVES from the language when the language changes.
 *
 * 🐞 Why (2026-08-22, reported from a Telegram Mini App: Ukrainian interface, dollar amounts).
 * A webview has its own storage, so `mt-locale` is empty there and this module primes to `en`.
 * `lib/currency.ts` primes from `getLocale()` at IMPORT and gets 840. Then `LocaleProvider`
 * fetches the account's locale, adopts `uk` and re-renders every string — but nothing told the
 * currency, so it stayed on dollars. And because the client states `x-mt-currency` on every
 * request, the server obligingly answered in dollars too, and `/rates` came back agreeing with
 * the value that was wrong: a loop with no way out but Settings.
 *
 * It is the same defect CLAUDE.md §i18n names for `Intl` formatters — a value read from the
 * locale at module level freezes — except the frozen value here is money. So the dependency
 * SUBSCRIBES instead of sampling. Listeners live here and not in a shared bus because the import
 * only runs one way (`currency` → `locale`); a back-import would be a cycle.
 */
const localeListeners = new Set<(l: Locale) => void>();

export function onLocaleChange(fn: (l: Locale) => void): void {
  localeListeners.add(fn);
}

// ---- lazy Intl formatters ----------------------------------------------------
//
// 🐞 Why these exist (reported on the live app: "next 19 серп." while the UI is English).
// Twenty modules held a formatter built at IMPORT time:
//
//     const dFmt = dateFmt({ … });
//
// That snapshots whatever the locale was when the module first loaded. Switching the language
// afterwards re-renders every label through `t()` — but the dates keep the OLD locale, because
// the formatter object never changes. The result is an English screen with Ukrainian months in
// it, which reads as a broken product rather than a missing translation.
//
// These helpers resolve the locale on every call and cache the constructed `Intl` object per
// (locale + options), so a switch is picked up immediately and hot paths (a list of 200 rows)
// still build the formatter once. Call sites keep the same `.format(x)` shape.
const fmtCache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat>(kind: string, opts: object, make: (tag: string) => T): T {
  const tag = localeTag(current);
  const key = `${kind}|${tag}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) { f = make(tag); fmtCache.set(key, f); }
  return f as T;
}

/** Locale-aware date formatter that follows a language switch. Drop-in for `Intl.DateTimeFormat`. */
export function dateFmt(opts: Intl.DateTimeFormatOptions): { format: (d: Date | number) => string } {
  return { format: (d) => cached("d", opts, (tag) => new Intl.DateTimeFormat(tag, opts)).format(d) };
}

/** Locale-aware number formatter that follows a language switch. */
export function numFmt(opts: Intl.NumberFormatOptions): { format: (n: number) => string } {
  return { format: (n) => cached("n", opts, (tag) => new Intl.NumberFormat(tag, opts)).format(n) };
}
