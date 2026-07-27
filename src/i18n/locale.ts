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
  current = l;
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
