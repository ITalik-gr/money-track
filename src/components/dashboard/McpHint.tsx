import { useState } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";
import { useGetMeQuery, useGetMcpQuery } from "../../store/api.ts";

/**
 * «You can point Claude at this ledger» — said once, quietly, to someone who has not yet.
 *
 * Built on `PrefsHint` rather than beside it, deliberately: same one-line strip, same dismiss,
 * same scoped storage key. A second visual idea for "a small aside on the dashboard" would be a
 * second thing to keep consistent for no gain.
 *
 * ⚠️ **It disappears on its own once anything is connected** — the condition is "no grants and no
 * token", not "not dismissed yet". An announcement that keeps running after you have acted on it
 * is the kind of nag people learn to look past, and then stop seeing the real ones too. Dismissal
 * is only for "not interested"; connecting is the other, better way to make it stop.
 *
 * ⚠️ The query is SKIPPED when the strip cannot render anyway (dismissed, demo, signed out), so
 * everyone who has already read this stops paying a request for it on every dashboard load.
 */
export function McpHint() {
  const t = useT();
  const { data: me } = useGetMeQuery();

  // Scoped by user id, like every per-user key in this storage (CLAUDE.md — a global key once
  // showed a demo visitor the owner's conversations).
  const key = me?.user?.id ? `mt-mcp-hint:${me.user.id}` : null;
  const [gone, setGone] = useState(() => {
    try { return key ? localStorage.getItem(key) === "1" : false; } catch { return false; }
  });

  // A demo sandbox lives 24h and the server refuses to connect one at all, so offering would be
  // a promise the product does not keep.
  const skip = gone || !key || !!me?.demo;
  const { data } = useGetMcpQuery(undefined, { skip });

  if (skip || !data) return null;
  if (data.connected_clients > 0 || data.active) return null;

  const dismiss = () => {
    setGone(true);
    try { localStorage.setItem(key, "1"); } catch { /* private mode — it will ask again, harmlessly */ }
  };

  return (
    <div className="prefs-hint">
      <Icon name="spark" size={14} />
      <span>
        {t("dash.mcpHintBody")}{" "}
        <Link to="/setup?tab=account" onClick={dismiss}>{t("dash.mcpHintCta")}</Link>
      </span>
      <button type="button" onClick={dismiss} aria-label={t("common.close")}>×</button>
    </div>
  );
}
