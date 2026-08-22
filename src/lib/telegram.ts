/**
 * Running inside a Telegram Mini App — detection and sign-in.
 *
 * ⚠️ **No `telegram-web-app.js`, on purpose.** Telegram's SDK is what most Mini Apps load to get
 * `window.Telegram.WebApp`, and it is a script from another origin — which `script-src 'self'`
 * forbids (`worker/index.ts`). Opening the CSP for one string, or vendoring a copy of somebody
 * else's script that silently ages, are both worse than reading the string ourselves: Telegram
 * puts the launch parameters in the URL FRAGMENT (`#tgWebAppData=…`), which is exactly where the
 * SDK reads them from.
 * Named cost: no `ready()`, `expand()` or theme API. The first only shortens Telegram's own
 * loading placeholder, and the app has its own theme — so nothing the user can see is missing.
 *
 * ⚠️ Captured at MODULE LOAD, before the router rewrites the URL. A fragment is not resent on a
 * later navigation, and by the time one happens the session cookie exists anyway.
 */
import { localeHeaders } from "../i18n/index.ts";

const INIT_DATA: string | null = (() => {
  try {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return null;
    const data = new URLSearchParams(hash).get("tgWebAppData");
    return data && data.length > 0 ? data : null;
  } catch { return null; }
})();

/** The signed launch payload, or null when this is an ordinary browser. */
export function telegramInitData(): string | null {
  return INIT_DATA;
}

/**
 * Exchange the launch payload for a session.
 *
 * A raw `fetch`, so the locale headers go on BY HAND through `localeHeaders()` — §LANG-ARCH: a
 * request outside RTK Query that forgets them is a request that does not say who is asking, and
 * this one decides which language the refusal comes back in.
 */
export async function signInWithTelegram(): Promise<{ ok: true } | { error: string }> {
  const initData = telegramInitData();
  if (!initData) return { error: "no_init_data" };
  try {
    const res = await fetch("/auth/miniapp", {
      method: "POST",
      headers: localeHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ init_data: initData }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({})) as { error?: string };
    return { error: body.error || `http_${res.status}` };
  } catch {
    // Offline inside a webview looks identical to a rejected payload unless we say otherwise.
    return { error: "network" };
  }
}
