import { Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";
import { useGetMeQuery, useGetSetupStatusQuery, useGetCredentialsQuery } from "../../store/api.ts";

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
  const { data: creds } = useGetCredentialsQuery();

  if (!status || me?.demo) return null;

  // Accounts and transactions are the two facts that decide whether this app has anything to
  // show. The webhook and rates matter too, but they are refinements — nagging about them on the
  // dashboard forever would train the user to ignore the banner.
  const noData = status.accounts === 0 || status.transactions === 0;

  // Since registration is open (2026-07-31), the second first-run gap is the AI key: there is no
  // deployment-wide fallback for anyone but the owner, so a new account's advisor, reports and
  // chat all fail with a raw error unless they bring their own key. Said once, on the first
  // screen, beats being discovered five times as a broken button.
  //
  // Ordered, not stacked: data first. Two banners on an empty dashboard is a wall, and the AI
  // has nothing to analyse until there are transactions anyway.
  // `available`, not `set`: the owner has no `user_secrets` row (their key comes from the
  // deployment secrets), and gating on `set` nagged them to add a key that already works.
  // The secret NAME is lower-case — comparing against "ANTHROPIC_API_KEY" never matched, so
  // this banner showed for everyone regardless.
  const aiSet = creds?.secrets.find((s) => s.name === "anthropic_api_key")?.available === true;
  const kind = noData ? "data" : !creds || aiSet ? null : "ai";
  if (!kind) return null;

  return (
    <Link to="/setup?tab=data" className="setup-nudge">
      <span className="sn-ico"><Icon name="spark" size={16} /></span>
      <span className="sn-body">
        <b>{t(kind === "data" ? "dash.setupNudgeTitle" : "dash.aiKeyNudgeTitle")}</b>
        <span>{t(kind === "data" ? "dash.setupNudgeBody" : "dash.aiKeyNudgeBody")}</span>
      </span>
      <span className="sn-cta">{t(kind === "data" ? "dash.setupNudgeCta" : "dash.aiKeyNudgeCta")} →</span>
    </Link>
  );
}
