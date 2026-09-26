// Applies the stored theme before first paint, so a dark-theme user never sees a light flash.
//
// A FILE rather than an inline <script> (moved 2026-07-26): the Content-Security-Policy sent by
// the Worker uses `script-src 'self'`, and an inline block would need either 'unsafe-inline' —
// which gives up most of what CSP is for — or a hash that has to be recomputed on every edit.
// Must stay render-blocking (no defer/async): the point is to run before the body paints.
//
// After first paint the theme belongs to `src/lib/theme.ts`. This file runs before any stylesheet,
// so it cannot read `--bg` and holds the chrome colours as literals: lint C23 checks that `BG` has
// exactly the themes of `THEMES` and that each value equals that theme file's `--bg`.
try {
  var BG = { light: "#f3f5f8", dark: "#0a0d13" };
  var t = localStorage.getItem("mt-theme");
  if (!BG.hasOwnProperty(t)) t = "light";
  document.documentElement.setAttribute("data-theme", t);
  // Keep the browser/PWA chrome in step with the page. Without this a dark-theme user gets a
  // light status bar sitting on top of a dark app — most visible in the installed PWA, where
  // that strip is part of the window rather than part of the browser.
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", BG[t]);
} catch (e) {
  /* private mode / storage disabled — the CSS default (light) already covers this */
}
