import { useState } from "react";
import { useGetMeQuery } from "../../store/api.ts";
import { CODE_LENGTH, isLockSet, setLock, clearLock } from "../../lib/lock.ts";
import { useT } from "../../i18n/index.ts";
import { toast } from "../../lib/toast.ts";

/**
 * Turning the local passcode on and off.
 *
 * ⚠️ The card states what the lock is NOT, in the product's own voice rather than in a footnote:
 * it hides the screen, it does not encrypt anything, and it does not stop someone who knows the
 * browser. A lock that implies more than it delivers is worse than no lock, because it changes
 * what people are willing to leave open on a table.
 */
export function LockCard() {
  const t = useT();
  const { data: me } = useGetMeQuery();
  const userId = me?.user?.id ?? "";
  const [on, setOn] = useState(() => (userId ? isLockSet(userId) : false));
  const [code, setCode] = useState("");
  const [confirm, setConfirm] = useState("");

  // A demo sandbox holds nobody's money and lasts a day; a passcode there is a barrier in front of
  // a product someone is seeing for the first time.
  if (!userId || me?.demo) return null;

  async function enable() {
    if (code.length !== CODE_LENGTH || code !== confirm) return;
    await setLock(userId, code);
    setOn(true); setCode(""); setConfirm("");
    toast.success(t("lock.enabled"));
  }

  function disable() {
    clearLock(userId);
    setOn(false);
    toast.success(t("lock.disabled"));
  }

  const digits = (v: string) => v.replace(/\D/g, "").slice(0, CODE_LENGTH);

  return (
    <section className="card set-full">
      <div className="set-head">
        <h2>{t("lock.cardTitle")}</h2>
        <span className="label">{t("lock.cardSub")}</span>
      </div>
      {on ? (
        <div className="row" style={{ gap: 10 }}>
          <span className="lock-on">{t("lock.isOn")}</span>
          <button className="btn" onClick={disable}>{t("lock.turnOff")}</button>
        </div>
      ) : (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input className="lock-field" inputMode="numeric" type="password" placeholder={t("lock.newCode")}
            value={code} onChange={(e) => setCode(digits(e.target.value))} />
          <input className="lock-field" inputMode="numeric" type="password" placeholder={t("lock.repeatCode")}
            value={confirm} onChange={(e) => setConfirm(digits(e.target.value))} />
          <button className="btn primary" disabled={code.length !== CODE_LENGTH || code !== confirm} onClick={enable}>
            {t("lock.turnOn")}
          </button>
        </div>
      )}
      {/* The honest limits, always visible — not behind a tooltip. */}
      <div className="lock-facts">{t("lock.caveat")}</div>
    </section>
  );
}
