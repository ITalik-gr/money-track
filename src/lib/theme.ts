// The theme, in JS — the ONE module that switches it and the one place a stored colour is turned
// into a paint (§THEME, §CAT-COLOR).
//
// Every colour value lives in CSS (`src/styles/theme-*.css`); this file only chooses WHICH set is
// active. It used to be two copies of the same toggle (`Layout`, `Landing`), each with its own
// hard-coded `theme-color` hex that had already drifted from `--bg`. Now:
//   · `setTheme()` writes the attribute, the stored choice and the browser-chrome colour, and every
//     `useTheme()` caller re-renders — one toggle can never leave another showing the old state;
//   · the chrome colour is READ from the live `--bg`, so a palette change cannot leave it behind.
//     `public/theme.js` runs before any stylesheet and must hold literals; lint C23 checks them
//     against each theme file's `--bg`.
import { useSyncExternalStore } from "react";

/** Every theme the app ships. A new one = a `src/styles/theme-<name>.css` with the full token set
 *  (C23 checks parity) + its name here + its `--bg` in `public/theme.js`. */
export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** The `localStorage` key. Read before paint by `public/theme.js` — keep the two in step (C23). */
const STORAGE_KEY = "mt-theme";

function isTheme(v: unknown): v is Theme {
  return (THEMES as readonly unknown[]).includes(v);
}

export function getTheme(): Theme {
  const t = document.documentElement.getAttribute("data-theme");
  return isTheme(t) ? t : "light";
}

const listeners = new Set<() => void>();

export function setTheme(next: Theme): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", next);
  // The browser/PWA chrome follows the page ground. Read after the attribute is set, so it is the
  // NEW theme's value (a synchronous style recalc) — without this the installed PWA keeps the old
  // theme's status bar until a reload.
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode — the switch still holds for this visit */
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The active theme and a toggle; every caller shares one state. */
export function useTheme(): { theme: Theme; dark: boolean; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, getTheme, () => "light" as Theme);
  return {
    theme,
    dark: theme === "dark",
    toggle: () => setTheme(theme === "dark" ? "light" : "dark"),
  };
}

/**
 * The paint for a STORED colour — a category, plan, goal, group or importance colour (§CAT-COLOR).
 *
 * The DB and the pickers hold the light palette (`#1f6e4c` …). On a dark card those sink — pine
 * is dark on dark — so the colour is mixed toward `--ink` by `--cat-keep`: 100% in light (the
 * stored hex, pixel-identical), 69% in dark. Being a CSS expression, it follows a theme switch
 * without a re-render. Idempotent: a value that is already a CSS expression (`var(--c-*)`, or a
 * previous `catColor`) passes through, so wrapping twice never lifts twice.
 *
 * Every inline paint of such a colour goes through here — lint C23 refuses a `style`/SVG paint of
 * a `…color` expression that does not.
 */
export function catColor(c: string): string;
export function catColor(c: string | null | undefined): string | undefined;
export function catColor(c: string | null | undefined): string | undefined {
  if (!c) return undefined;
  if (!c.startsWith("#")) return c;
  return `color-mix(in srgb, ${c} var(--cat-keep), var(--ink))`;
}

/** The six stored-palette tokens, lifted per theme — for a colour the data did not supply. */
export const CAT_FALLBACK = [
  "var(--c-pine)", "var(--c-cobalt)", "var(--c-plum)", "var(--c-ochre)", "var(--c-brick)", "var(--c-teal)", "var(--c-slate)",
] as const;
