import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { Select } from "../ui/Select.tsx";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import type { TaxProfile } from "../../store/api.ts";

/**
 * The group, the rate, the exemption — typed by the user, never guessed.
 *
 * ⚠️ §BIZ-SPLIT (2026-09-21): configuration ONLY. Whether the tax module is on at all is a switch
 * in `BizSetup`, because it is now one of two independent switches and no longer a property of
 * this card.
 *
 * ⚠️ A guessed group produces a confidently wrong tax figure, and wrong-and-confident is the one
 * failure on this page that costs a penalty rather than an evening (docs/TAX.md §7). So nothing
 * here has a default that pretends to know: the tax tab appears only once these are answered.
 *
 * ⚠️ The card also states, once and plainly, that the app is not a tax adviser: every number on
 * the tax tab follows from what is entered here.
 */
export function TaxProfileCard({ profile, onSave, saving }: {
  profile: TaxProfile | undefined;
  onSave: (p: Partial<TaxProfile>) => { unwrap: () => Promise<unknown> };
  saving: boolean;
}) {
  const t = useT();
  const [group, setGroup] = useState(String(profile?.group ?? 3));
  const [vat, setVat] = useState(!!profile?.vat);
  const [esvExempt, setEsvExempt] = useState(!!profile?.esv_exempt);

  const save = async (patch: Partial<TaxProfile>) => {
    try { await onSave(patch).unwrap(); } catch (e) { toast.error(errText(e)); }
  };

  return (
    <div className="card">
      <div className="section-head"><h3>{t("fop.profile")}</h3></div>

      <div className="fop-profile-row">
        <label>{t("fop.group")}</label>
        <Select
          value={group}
          onChange={(v) => setGroup(String(v ?? 3))}
          options={[
            { value: "1", label: t("fop.group1") },
            { value: "2", label: t("fop.group2") },
            { value: "3", label: t("fop.group3") },
          ]}
        />
      </div>

      {group === "3" && (
        <label className="fop-check">
          <input type="checkbox" checked={vat} onChange={(e) => setVat(e.target.checked)} />
          <span>{t("fop.vat")}</span>
        </label>
      )}

      {/* A flag rather than an assumption in either direction: the blanket wartime exemption is
          suspended for 2026 and only the mobilised mechanism remains, so assuming «pays» bills a
          mobilised person for money they do not owe, and assuming «exempt» hides a real debt. */}
      <label className="fop-check">
        <input type="checkbox" checked={esvExempt} onChange={(e) => setEsvExempt(e.target.checked)} />
        <span>{t("fop.esvExempt")}</span>
      </label>

      {/* §BIZ-SPLIT — this card no longer turns the module ON or OFF. That is two switches now,
          and they live in `BizSetup`: a card that both configures a thing and toggles it made
          «Save» ambiguous — it enabled the module as a side effect of correcting a rate. */}
      <div className="fop-profile-actions">
        <button
          className="btn primary"
          disabled={saving}
          onClick={() => save({ group: Number(group) as 1 | 2 | 3, vat, esv_exempt: esvExempt })}
        >{t("common.save")}</button>
      </div>

      <p className="fop-note">{t("fop.notAdvice")}</p>
    </div>
  );
}
