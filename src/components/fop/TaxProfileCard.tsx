import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { Select } from "../ui/Select.tsx";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import type { TaxProfile } from "../../store/api.ts";

/**
 * The group, the rate, the exemption — typed by the user, never guessed.
 *
 * ⚠️ A guessed group produces a confidently wrong tax figure, and wrong-and-confident is the one
 * failure on this page that costs a penalty rather than an evening (docs/TAX.md §7). So the whole
 * screen stays behind this card until it is answered, and `intro` is the version that says why.
 *
 * ⚠️ The card also states, once and plainly, that the app is not a tax adviser: every number on
 * `/fop` follows from what is entered here.
 */
export function TaxProfileCard({ profile, onSave, saving, intro }: {
  profile: TaxProfile | undefined;
  onSave: (p: Partial<TaxProfile>) => { unwrap: () => Promise<unknown> };
  saving: boolean;
  intro?: boolean;
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
      {intro && <p className="fop-note">{t("fop.introNote")}</p>}

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

      <div className="fop-profile-actions">
        <button
          className="btn primary"
          disabled={saving}
          onClick={() => save({ enabled: true, group: Number(group) as 1 | 2 | 3, vat, esv_exempt: esvExempt })}
        >{intro ? t("fop.enable") : t("common.save")}</button>
        {!intro && profile?.enabled && (
          <button className="btn ghost" disabled={saving} onClick={() => save({ enabled: false })}>
            {t("fop.disable")}
          </button>
        )}
      </div>

      <p className="fop-note">{t("fop.notAdvice")}</p>
    </div>
  );
}
