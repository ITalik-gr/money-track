import { useT } from "../../i18n/index.ts";
import { TaxProfileCard } from "./TaxProfileCard.tsx";
import { BizSwitches } from "./BizSwitches.tsx";
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
  const taxOn = !!profile?.enabled;

  return (
    <>
      <BizSwitches profile={profile} onSave={onSave} saving={saving} locked={sample} />

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
