import { useRouteError, Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { errText } from "../../lib/errors.ts";
import { Icon } from "../ui/Icon.tsx";

/**
 * The router's error screen, in place of React Router's developer page («Unexpected Application
 * Error! … Hey developer 👋»), which is what the owner saw in production on 2026-11-07.
 *
 * ⚠️ A STALE CHUNK is not a bug in the page, it is a deploy: every page is its own lazily loaded
 * chunk (App.tsx), a deploy replaces the hashed file names, and a tab opened before it asks for a
 * file that no longer exists. A reload fetches the new entry and the page works — so that case
 * reloads ONCE by itself. The timestamp guard stops a genuinely missing chunk from reloading
 * forever: a second failure within a minute shows the screen like any other error.
 */
const STALE_CHUNK = /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk \d+ failed/i;
const RELOAD_KEY = "mt-chunk-reload-at";

function reloadedRecently(): boolean {
  try { return Date.now() - Number(sessionStorage.getItem(RELOAD_KEY) ?? 0) < 60_000; } catch { return true; }
}

export function RouteError() {
  const t = useT();
  const error = useRouteError();
  const text = errText(error);

  if (STALE_CHUNK.test(text) && !reloadedRecently()) {
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* private window */ }
    window.location.reload();
    return null;
  }

  return (
    <div className="card empty-card" role="alert">
      <span className="ec-ico"><Icon name="alert" size={18} /></span>
      <div className="ec-title">{t("routeerr.title")}</div>
      <p className="ec-hint">{t("routeerr.hint")}</p>
      <p className="ec-hint">{text}</p>
      <button className="btn sm" onClick={() => window.location.reload()}>{t("routeerr.reload")}</button>
      <Link to="/" className="btn sm">{t("routeerr.home")}</Link>
    </div>
  );
}
