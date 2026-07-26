// Applies the stored theme before first paint, so a dark-theme user never sees a light flash.
//
// A FILE rather than an inline <script> (moved 2026-07-26): the Content-Security-Policy sent by
// the Worker uses `script-src 'self'`, and an inline block would need either 'unsafe-inline' —
// which gives up most of what CSP is for — or a hash that has to be recomputed on every edit.
// Must stay render-blocking (no defer/async): the point is to run before the body paints.
try {
  var t = localStorage.getItem("mt-theme") || "light";
  document.documentElement.setAttribute("data-theme", t);
} catch (e) {
  /* private mode / storage disabled — the CSS default (light) already covers this */
}
