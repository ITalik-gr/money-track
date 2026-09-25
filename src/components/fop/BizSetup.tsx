import { Link } from "react-router-dom";
import { useT } from "../../i18n/index.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { TaxProfileCard } from "./TaxProfileCard.tsx";
import type { TaxProfile } from "../../store/api.ts";

/**
 * §BIZ-SPLIT — the two switches, and the reason they are two.
 *
 * «Business» is «I have work income and work costs, keep them apart from my own money». «ФОП» is
 * «and the state charges me for it». The owner asked for exactly this separation (2026-09-21:
 * «щоб можна було і просто свій бізнес фінанси трекати, а фоп вже це як фіча просто додаткова»),
 * and it is the honest shape anyway: a freelancer before registration, a person between
 * registrations, and someone whose ФОП an accountant runs all have the first and not the second.
 *
 * ⚠️ The tax switch is DISABLED while business is off, rather than silently turning business on
 * behind the user's back. The server enforces the implication (`writeProfile`); the screen shows
 * it, because a checkbox that quietly changes another checkbox is how a person stops trusting the
 * settings page.
 *
 * ⚠️ Nothing here guesses the group. A guessed group produces a confidently wrong tax figure, and
 * that is the single failure on this page that costs a penalty rather than an evening
 * (docs/TAX.md §7) — so `TaxProfileCard` stays the gate it has always been.
 */
export function BizSetup({ profile, onSave, saving, sample, onSample }: {
  profile: TaxProfile | undefined;
  onSave: (p: Partial<TaxProfile>) => { unwrap: () => Promise<unknown> };
  saving: boolean;
  sample: boolean;
  onSample: (on: boolean) => void;
}) {
  const t = useT();
  const business = !!profile?.business;
  const taxOn = !!profile?.enabled;

  const save = async (patch: Partial<TaxProfile>) => {
    try { await onSave(patch).unwrap(); } catch (e) { toast.error(errText(e)); }
  };

  return (
    <>
      <div className="card">
        <div className="section-head"><h3>{t("fop.whatWeTrack")}</h3></div>

        <label className="fop-check">
          <input
            type="checkbox" role="switch" className="switch"
            checked={business}
            disabled={saving || sample}
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
            disabled={saving || sample || !business}
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

      {taxOn && <TaxProfileCard profile={profile} onSave={onSave} saving={saving} />}

      <div className="card">
        <div className="section-head"><h3>{t("fop.sampleTitle")}</h3></div>
        {/* The alternative — seeding demonstration rows into the real ledger — was rejected: this
            page reports money, and a synthetic receipt that outlives the demonstration is a wrong
            figure in a tax export. The sample is built in the browser and written nowhere. */}
        <p className="fop-note">{t("fop.sampleNote")}</p>
        <label className="fop-check">
          <input type="checkbox" checked={sample} onChange={(e) => onSample(e.target.checked)} />
          <span>{t("fop.sampleOn")}</span>
        </label>
      </div>
    </>
  );
}
