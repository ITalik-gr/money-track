import { useState } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";
import { useGetMeQuery, useGetBaseCurrencyQuery } from "../../store/api.ts";

/**
 * «The language and the currency are a guess — go and make them yours» (2026-08-22).
 *
 * Requested after the report that started as a bug: a Ukrainian interface printing dollars. The
 * defect itself is fixed (`lib/currency.ts` follows the language now), but the DEFAULT stays a
 * guess either way — the app has to pick something before it has met anybody, and English/dollars
 * is what a stranger gets. Nothing on the screen said that was a default rather than a decision.
 *
 * ⚠️ **Deliberately quiet, and deliberately not a `setup-nudge`.** That component announces a
 * BROKEN state — no data, no AI key — and earns its card by being about something that stops the
 * app working. This is about a preference: it is correct until the reader disagrees, so it gets a
 * line of small text and a dismiss, not a banner. A new account shows the setup nudge already,
 * and two cards stacked on an empty dashboard is a wall.
 *
 * ⚠️ The trigger is `stored === null` — the SERVER has no saved currency, i.e. nobody ever chose
 * on this ACCOUNT. Asking the device instead (`hasStoredBaseCurrency()`) would re-open the hint
 * on every new phone and in every private window, which turns "said once on your first visit"
 * into "said forever". Dismissal, in contrast, IS per-device: it records reading, not deciding.
 */
export function PrefsHint() {
  const t = useT();
  const { data: me } = useGetMeQuery();
  const { data: cur } = useGetBaseCurrencyQuery();

  // Scoped by user id, like every other per-user key in this storage (CLAUDE.md — a global key
  // once showed a demo visitor the owner's conversations).
  const key = me?.user?.id ? `mt-prefs-hint:${me.user.id}` : null;
  const [gone, setGone] = useState(() => {
    try { return key ? localStorage.getItem(key) === "1" : false; } catch { return false; }
  });

  // A demo is a sandbox that lives a day and has no settings worth keeping; and until `cur` has
  // loaded, saying nothing beats a line that appears and then disappears on every page load.
  if (!cur || gone || !key || me?.demo) return null;
  if (cur.stored !== null) return null;   // they have already chosen — nothing to explain

  const dismiss = () => {
    setGone(true);
    try { localStorage.setItem(key, "1"); } catch { /* private mode — it will ask again, harmlessly */ }
  };

  return (
    <div className="prefs-hint">
      <Icon name="spark" size={14} />
      <span>
        {t("dash.prefsHintBody")}{" "}
        <Link to="/setup?tab=account" onClick={dismiss}>{t("dash.prefsHintCta")}</Link>
      </span>
      <button type="button" onClick={dismiss} aria-label={t("common.close")}>×</button>
    </div>
  );
}
