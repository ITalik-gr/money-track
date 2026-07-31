// Applies the stored theme before first paint, so a dark-theme user never sees a light flash.
//
// A FILE rather than an inline <script> (moved 2026-07-26): the Content-Security-Policy sent by
// the Worker uses `script-src 'self'`, and an inline block would need either 'unsafe-inline' —
// which gives up most of what CSP is for — or a hash that has to be recomputed on every edit.
// Must stay render-blocking (no defer/async): the point is to run before the body paints.
try {
  var t = localStorage.getItem("mt-theme") || "light";
  document.documentElement.setAttribute("data-theme", t);
  // Keep the browser/PWA chrome in step with the page. Without this a dark-theme user gets a
  // light status bar sitting on top of a dark app — most visible in the installed PWA, where
  // that strip is part of the window rather than part of the browser.
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t === "dark" ? "#0b0f14" : "#f3f5f8");
} catch (e) {
  /* private mode / storage disabled — the CSS default (light) already covers this */
}
