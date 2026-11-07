import { Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import type { TaxProfile } from "../../store/api.ts";

/**
 * §BIZ-SPLIT — the two module switches («Бізнес-облік», «ФОП і податки») as one card.
 *
 * Shared by `/business` → Settings and the app's own Settings → General. The owner, who has no
 * ФОП, could not find how to turn the module off (2026-11-07): it lived only on the business
 * page's last tab, while the module kept subtracting a phantom tax reserve from «safe to spend»
 * and announcing an overdue ЄСВ. A switch that changes a personal screen belongs where personal
 * settings are looked for.
 *
 * ⚠️ The tax switch is DISABLED while business is off, rather than silently turning business on
 * behind the user's back. The server enforces the implication (`writeProfile`); the screen shows
 * it, because a checkbox that quietly changes another checkbox is how a person stops trusting the
 * settings page.
 */
export function BizSwitches({ profile, onSave, saving, locked = false }: {
  profile: TaxProfile | undefined;
  onSave: (p: Partial<TaxProfile>) => { unwrap: () => Promise<unknown> };
  saving: boolean;
  /** The business page's sample mode: nothing real may be written while it is on. */
  locked?: boolean;
}) {
  const t = useT();
  const business = !!profile?.business;
  const taxOn = !!profile?.enabled;

  const save = async (patch: Partial<TaxProfile>) => {
    try { await onSave(patch).unwrap(); } catch (e) { toast.error(errText(e)); }
  };

  return (
    <div className="card">
      <div className="section-head"><h3>{t("fop.whatWeTrack")}</h3></div>

      <label className="fop-check">
        <input
          type="checkbox" role="switch" className="switch"
          checked={business}
          disabled={saving || locked}
          onChange={(e) => save({ business: e.target.checked })}
        />
        <span>
          <b>{t("fop.bizOn")}</b>
          <small className="fop-note">{t("fop.bizOnNote")}</small>
        </span>
      </label>

      <label className={`fop-check ${business ? "" : "is-off"}`}>
        <input
          type="checkbox" role="switch" className="switch"
          checked={taxOn}
          // Off, not hidden: somebody looking for the tax module must find it and see WHY it is
          // unavailable, rather than conclude the app does not have one.
          disabled={saving || locked || !business}
          onChange={(e) => save({ enabled: e.target.checked })}
        />
        <span>
          <b>{t("fop.taxOn")}</b>
          <small className="fop-note">{business ? t("fop.taxOnNote") : t("fop.taxNeedsBiz")}</small>
        </span>
      </label>

      {/* §TAX-BASE — the switch the whole module actually depends on lives on the ACCOUNT, and
          it is on another page. Said here because an empty business screen with no explanation
          reads as a broken feature, when the real cause is that no account was ever marked. */}
      {business && (
        <p className="fop-note">
          {t("fop.markAccounts")} <Link to="/accounts">{t("nav.accounts")}</Link>
        </p>
      )}
    </div>
  );
}
