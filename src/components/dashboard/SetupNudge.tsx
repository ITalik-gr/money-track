import { Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";
import { useGetMeQuery, useGetSetupStatusQuery } from "../../store/api.ts";

/**
 * "Your setup is not finished yet" — on the dashboard, where it cannot be missed (D0).
 *
 * A checklist buried in Settings only helps someone who already suspects there is one. A new
 * account with no bank connected shows empty cards and zero balances, which reads as a broken
 * app rather than an unfinished setup — so the state has to be announced on the first screen,
 * with the way to fix it one click away.
 *
 * Deliberately NOT shown when:
 *   - `status` has not loaded — an incomplete-setup claim that appears and then vanishes on every
 *     page load is worse than silence;
 *   - this is a demo sandbox — it is seeded, and its webhook is never registered by design, so
 *     the banner would be permanently wrong there.
 */
export function SetupNudge() {
  const t = useT();
  const { data: me } = useGetMeQuery();
  const { data: status } = useGetSetupStatusQuery();

  if (!status || me?.demo) return null;
  // Accounts and transactions are the two facts that decide whether this app has anything to
  // show. The webhook and rates matter too, but they are refinements — nagging about them on the
  // dashboard forever would train the user to ignore the banner.
  const missing = status.accounts === 0 || status.transactions === 0;
  if (!missing) return null;

  return (
    <Link to="/setup?tab=data" className="setup-nudge">
      <span className="sn-ico"><Icon name="spark" size={16} /></span>
      <span className="sn-body">
        <b>{t("dash.setupNudgeTitle")}</b>
        <span>{t("dash.setupNudgeBody")}</span>
      </span>
      <span className="sn-cta">{t("dash.setupNudgeCta")} →</span>
    </Link>
  );
}
