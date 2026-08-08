import { createContext, createElement, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import en from "./en.json";
import uk from "./uk.json";
import { getLocale, hasStoredLocale, initialLocale, localeTag, setLocale } from "./locale.ts";
import type { Locale } from "./locale.ts";
import { store } from "../store/index.ts";
import { api, useGetMeQuery } from "../store/api.ts";

// Category display names are resolved SERVER-SIDE in the owner locale (P3.4). Switching language
// must therefore refetch anything that carries a category name — the client can't retranslate a
// string it received already-resolved. Invalidated AFTER the locale PUT lands (see `change`),
// never before: the server reads the new locale from app_state, so an earlier refetch would race
// and get the old language back.
const LOCALE_DEPENDENT_TAGS = [
  "Tx", "Summary", "Category", "Insight", "Advice", "Report", "Event", "Budget", "Planned",
] as const;

export type { Locale };
export { getLocale, localeTag, setLocale };

// `en` is the source of truth for the key set: a `t()` call with a key missing from en fails
// in tsc. The uk map only has to STAY in parity, which the i18n lint checks separately.
export type TranslationKey = keyof typeof en;

const dicts: Record<Locale, Record<string, string>> = { en, uk };

export type TParams = Record<string, string | number>;

/** Look up `key` in the active locale, fall back to English, then to the raw key so a missing
 *  string is visible (as the key) rather than blank. `{name}` placeholders are interpolated. */
export function translate(locale: Locale, key: TranslationKey, params?: TParams): string {
  let s = dicts[locale][key] ?? dicts.en[key] ?? (key as string);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}

const LocaleContext = createContext<{
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: TranslationKey, params?: TParams) => string;
}>({
  locale: getLocale(),
  setLocale: () => {},
  t: (key) => key as string,
});

/** Tell the server which locale this account displays in. Fire-and-forget: the UI never blocks
 *  on it, but the caches carrying server-resolved category names must be dropped afterwards. */
/**
 * Every request says which language the reader is looking at — including the two hand-written
 * `fetch`es in this file.
 *
 * RTK Query adds `x-mt-locale` in `prepareHeaders`, but these two do not go through it, and neither
 * does the chat stream (`lib/aiStream.ts` sets it by hand for the same reason). That mattered most
 * for the GET below: it is the call that DECIDES whether to adopt the server's language, and it was
 * asking the server what language to use without telling it who was asking.
 */
const localeHeaders = (extra?: Record<string, string>): Record<string, string> =>
  ({ "x-mt-locale": getLocale(), ...extra });

function pushLocale(l: Locale): void {
  fetch("/api/settings/locale", {
    method: "PUT",
    // The body carries the NEW value; the header carries what is on screen right now. They differ
    // for exactly one request — this one — and the server reads the body for the write.
    headers: localeHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ locale: l }),
  })
    .then(() => {
      store.dispatch(api.util.invalidateTags([...LOCALE_DEPENDENT_TAGS]));
    })
    .catch(() => {
      /* offline / anonymous — localStorage already holds the choice */
    });
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale());
  const { data: me } = useGetMeQuery();
  // Identity, not just "mounted": the app does NOT remount after a password login, so an effect
  // keyed on mount ran while still anonymous and never looked at the account's locale again.
  const identity = me?.authenticated ? (me.demo ? "demo" : me.user?.id ?? "?") : null;

  // Reconcile the browser's locale with the account's, in BOTH directions.
  //
  // Category names are resolved SERVER-SIDE in the account's locale (`catNameSql`, P3.4) while
  // every other string is translated on the client. So these two values are not a preference —
  // they are one setting stored in two places, and any disagreement renders visibly wrong: a
  // Ukrainian UI listing "Supermarket / Groceries". The old code returned early whenever a local
  // choice existed, which made that disagreement permanent instead of transient.
  useEffect(() => {
    if (!identity) return; // anonymous: no account state to reconcile with
    let cancelled = false;
    fetch("/api/settings/locale", { headers: localeHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { locale?: string } | null) => {
        if (cancelled || !j) return;
        const server = j.locale === "uk" || j.locale === "en" ? j.locale : null;
        const local = getLocale();
        // What this sync is FOR, now that `x-mt-locale` rides on every request: the paths with no
        // request. Cron reports, Telegram pushes and the notification feed have no header to read,
        // so `app_state.locale` is their only source and it has to be kept in step with the screen.
        // Anything with a reader attached is already decided by the header (`resolveLocale`).
        //
        // The server has no opinion yet → give it the one the reader is actually looking at. For a
        // fresh demo that is now ALWAYS the case: the sandbox no longer inherits a `locale` row
        // from the fixture (see DEMO_EXCLUDED_STATE_KEYS), which used to hand `resolveLocale` a
        // stored answer to prefer over the visitor's own — the toggle said EN while the categories
        // and the AI came back Ukrainian.
        if (!server) { pushLocale(local); return; }
        if (hasStoredLocale() || me?.demo) {
          // An explicit local choice wins, and so does the reader in a demo: a sandbox lives 24
          // hours and accumulates no preference worth overruling the person looking at it. Push,
          // so the request-less paths agree.
          //
          // ⚠️ `!me?.demo` used to sit here, which made the sandbox's stored value beat the
          // visitor. That was defensible while the fixture seeded a language on purpose; with that
          // row gone it would only mean "whatever the last PUT happened to write wins over the
          // person reading the screen".
          if (server !== local) pushLocale(local);
          return;
        }
        if (server && server !== local) {
          setLocale(server, false); // adopt without marking as an explicit choice
          setLocaleState(server);
        }
      })
      .catch(() => {
        /* offline — keep the browser default */
      });
    return () => {
      cancelled = true;
    };
  }, [identity, me?.demo]);

  // Keep `<html lang>` on the language actually being shown. `index.html` ships `lang="uk"` as a
  // static value, so every English screen was claiming to be Ukrainian — which is what screen
  // readers pick a voice from, what the browser's translate prompt reads, and what hyphenation
  // follows. It is NOT what decides the `dd.mm.yyyy` in a native date input: that comes from the
  // browser's own locale (Chromium: UI language; Safari: system region), which a page cannot set.
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const change = useCallback((l: Locale) => {
    setLocale(l, true); // module value + localStorage (explicit choice)
    setLocaleState(l);
    pushLocale(l);
  }, []);

  const t = useCallback((key: TranslationKey, params?: TParams) => translate(locale, key, params), [locale]);

  return createElement(LocaleContext.Provider, { value: { locale, setLocale: change, t } }, children);
}

export function useLocale() {
  return useContext(LocaleContext);
}

/** Shorthand: `const t = useT();` → `t("nav.overview")`. */
export function useT() {
  return useContext(LocaleContext).t;
}
