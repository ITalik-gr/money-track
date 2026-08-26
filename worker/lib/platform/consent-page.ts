/**
 * §MCP-OAUTH — the consent screen, as HTML the worker renders itself.
 *
 * The only full page this worker serves; everything else is JSON or the SPA. It cannot be a React
 * route, because it has to exist BEFORE any token does and it must be reachable inside whatever
 * browser window Claude opened, which carries no application state at all.
 *
 * ⚠️ Every interpolated value is escaped. Two of them — the client's name and its redirect URI —
 * are attacker-chosen: anyone can register a client via RFC 7591 with `client_name` set to markup.
 * The page also lands under this app's CSP (`script-src 'self'`), so even a successful injection
 * would have nowhere to run from — but the escape is what makes that a second line of defence
 * rather than the only one.
 *
 * ⚠️ No inline `<script>`, deliberately: the CSP forbids it, and a consent screen that silently
 * fails to render is a connection that fails with no explanation. Plain form, plain POST.
 */
import { st, type ServerLocale } from "./i18n.ts";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c
  ));
}

export interface ConsentView {
  locale: ServerLocale;
  clientName: string;
  redirectHost: string;
  isLoopback: boolean;
  email: string;
  /** Signed blob carrying the whole request, so the POST cannot be assembled by hand. */
  request: string;
}

export function consentPage(v: ConsentView): string {
  const t = (k: Parameters<typeof st>[1], p?: Record<string, string>) => esc(st(v.locale, k, p));
  return `<!doctype html>
<html lang="${v.locale === "en" ? "en" : "uk"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t("consentTitle")}</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1a1a18; --mut:#6b6b66; --line:#e4e4e0; --card:#fff; --accent:#c86a3a; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1a1a18; --fg:#ececea; --mut:#9a9a94; --line:#333330; --card:#232320; }
  }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; padding:24px; }
  .card { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line);
          border-radius:14px; padding:26px; }
  h1 { font-size:19px; margin:0 0 14px; }
  p { margin:0 0 10px; }
  .mut { color:var(--mut); font-size:13.5px; }
  .warn { color:var(--accent); font-size:13.5px; font-weight:550; }
  .facts { border-top:1px solid var(--line); margin-top:16px; padding-top:14px; }
  .row { display:flex; gap:10px; margin-top:16px; }
  button { flex:1; padding:11px 14px; font:inherit; font-weight:600; border-radius:9px; cursor:pointer;
           border:1px solid var(--line); background:transparent; color:var(--fg); }
  button.ok { background:var(--accent); border-color:var(--accent); color:#fff; }
</style>
</head>
<body>
<main class="card">
  <h1>${t("consentTitle")}</h1>
  <p>${t("consentIntro", { client: v.clientName })}</p>
  <p class="mut">${t("consentGrants")}</p>
  <p class="mut">${t("consentReadOnly")}</p>
  <div class="facts">
    <p class="mut">${t("consentAccount", { email: v.email })}</p>
    <p class="mut">${t("consentRedirect", { host: v.redirectHost })}</p>
    ${v.isLoopback ? `<p class="warn">${t("consentLoopback")}</p>` : ""}
  </div>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="request" value="${esc(v.request)}">
    <div class="row">
      <button type="submit" name="decision" value="deny">${t("consentDeny")}</button>
      <button type="submit" name="decision" value="allow" class="ok">${t("consentApprove")}</button>
    </div>
  </form>
</main>
</body>
</html>`;
}
