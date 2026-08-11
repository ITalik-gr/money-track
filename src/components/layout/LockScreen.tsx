import { useEffect, useRef, useState } from "react";
import { CODE_LENGTH, verifyLock, markUnlocked } from "../../lib/lock.ts";
import { useT } from "../../i18n/index.ts";

/**
 * The passcode screen, shown over everything until the code is entered.
 *
 * ⚠️ It covers the app rather than replacing the route: the data behind it is already fetched and
 * in memory, and pretending otherwise would be theatre. What it prevents is the screen being
 * READ — see `lib/lock.ts` for the honest limits.
 *
 * No lockout after N wrong tries. It would be security theatre against an attacker who can bypass
 * the whole thing from devtools, and a real cost to the actual user, who is the person most likely
 * to fat-finger a digit on a phone.
 */
export function LockScreen({ userId, onUnlock }: { userId: string; onUnlock: () => void }) {
  const t = useT();
  const [code, setCode] = useState("");
  const [wrong, setWrong] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Submits itself on the last digit: a four-digit code with a separate confirm button asks for
  // one gesture more than the gesture is worth.
  useEffect(() => {
    if (code.length !== CODE_LENGTH) return;
    let alive = true;
    void (async () => {
      if (await verifyLock(userId, code)) {
        markUnlocked();
        onUnlock();
      } else if (alive) {
        setWrong(true);
        setCode("");
        // The shake is the only feedback, and it repeats on every failure — hence resetting the
        // flag rather than leaving it on.
        setTimeout(() => alive && setWrong(false), 500);
      }
    })();
    return () => { alive = false; };
  }, [code, userId, onUnlock]);

  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-label={t("lock.title")}>
      <div className={`lock-box ${wrong ? "wrong" : ""}`}>
        <div className="lock-title">{t("lock.title")}</div>
        <div className="lock-dots" aria-hidden>
          {Array.from({ length: CODE_LENGTH }, (_, i) => (
            <span key={i} className={i < code.length ? "on" : ""} />
          ))}
        </div>
        {/* A real input, off-screen but focusable: it brings up the numeric keypad on a phone and
            gives the browser's own accessibility affordances, which a grid of custom buttons would
            have to reimplement badly. */}
        <input
          ref={inputRef}
          className="lock-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-label={t("lock.title")}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))}
        />
        <div className="lock-hint">{wrong ? t("lock.wrong") : t("lock.hint")}</div>
      </div>
    </div>
  );
}
