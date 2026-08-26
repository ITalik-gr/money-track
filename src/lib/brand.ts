import { useSyncExternalStore } from "react";
import { currencySign } from "../../shared/currency.ts";
import { getBaseCurrency, onBaseCurrencyChange } from "./currency.ts";

/**
 * The brand mark — the glyph inside the ink square, and the icon in the browser tab.
 *
 * **It follows the reader's display currency, on purpose.** The app rolls a multi-currency ledger
 * up into ONE unit (§BASE-CUR) and the mark is that unit's own sign: someone reading in dollars
 * gets the dollar mark, someone reading in hryvnia the hryvnia one. This is the one place where a
 * logo that changes is right rather than sloppy — it is the same statement the numbers underneath
 * it are making, and it changes exactly when they do.
 *
 * ⚠️ **The dollar is the DEFAULT, not an accident.** Anything without artwork of its own — a base
 * we have no mark for, a currency inherited from a language, the first paint before `/rates` has
 * answered — resolves to it. A mark that follows a setting still has to have a value when there is
 * no setting yet.
 *
 * ⚠️ **The artwork is not the text.** `brandMark()` returns a character for the in-app chip, where
 * it is rendered in the app's own font; `brandIcon()` returns a FILE, because a browser tab and a
 * launcher cannot render a font glyph. The two must agree, so a currency with no icon file falls
 * back to the dollar in both.
 *
 * ⚠️ **The installed app icon does NOT follow** — `public/icons/*.png` are named in the manifest,
 * which is static and is read once at install time. They carry the dollar (the default). This is a
 * limit of the platform, not an oversight: the alternative is a manifest generated per user, which
 * an installed PWA would still not re-read.
 */

/** Artwork exists for these; everything else is the dollar. Values are paths under `public/`. */
const ICONS: Record<number, string> = {
  980: "/icons/mark-uah.svg",
  978: "/icons/mark-eur.svg",
};
const DEFAULT_ICON = "/favicon.svg";

/** The glyph for the current base — what the `.mark` chip prints. */
export function brandMark(): string {
  return currencySign(getBaseCurrency());
}

/** The icon file for the current base. */
export function brandIcon(): string {
  return ICONS[getBaseCurrency()] ?? DEFAULT_ICON;
}

/**
 * Re-render the chip when the base changes. `useSyncExternalStore` rather than a `useEffect` +
 * `useState` pair: the currency is primed at import and can be set before this component ever
 * mounts (the `/rates` answer arrives early), and the effect version renders one frame with the
 * old sign in that case — a wrong currency sign, in the logo, for one frame, on every load.
 */
export function useBrandMark(): string {
  return useSyncExternalStore(onBaseCurrencyChange, brandMark, brandMark);
}

/**
 * Point `<link rel="icon">` at the current mark.
 *
 * ⚠️ The tag is REPLACED, not mutated. Chrome ignores an `href` written onto the existing link
 * often enough that it looks intermittent; removing the node and inserting a fresh one is the
 * behaviour every browser actually implements. The `sizes="any"` marks it as the scalable icon so
 * a cached `/favicon.ico` guess cannot win.
 */
export function applyBrandIcon(): void {
  const href = brandIcon();
  const head = document.head;
  if (!head) return;
  const existing = head.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (existing?.getAttribute("href")?.split("?")[0] === href) return;
  existing?.remove();
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.sizes = "any";
  link.href = href;
  head.appendChild(link);
}

// Applied at import and kept in step from here on. A module-level subscription rather than an
// effect in some component: the tab icon belongs to the document, not to whichever screen happens
// to be mounted, and it must survive every route change without a component owning it.
if (typeof document !== "undefined") {
  applyBrandIcon();
  onBaseCurrencyChange(applyBrandIcon);
}
