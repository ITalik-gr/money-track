/**
 * The sign-in screen INSIDE a Telegram Mini App.
 *
 * A separate screen rather than a branch on `Login`, because the two have nothing in common: this
 * one has no button on the happy path (it signs in by itself from the launch payload), and its
 * unhappy path cannot offer Google — that is the whole reason it exists. Showing a Google button
 * that always fails `bad_state` here would be the app promising something it cannot do.
 *
 * ⚠️ **The failure state must not be a dead end** (2026-08-22, reported: «в міні апці просто
 * показує, що з неї не можна зайти»). Whatever the reason, there are exactly two useful moves —
 * go and link the account in a real browser, and try again after doing so — so both are on the
 * screen. The raw reason code is printed too: this screen is the only place the cause is visible
 * at all, and «could not sign in» with nothing else is a report nobody can act on.
 */
import { useCallback, useEffect, useState } from "react";
import { signInWithTelegram } from "../lib/telegram.ts";
import { useT, type TranslationKey } from "../i18n/index.ts";

const REASONS: Record<string, TranslationKey> = {
  // The ONE that is not an error: the account exists, it has simply never been linked to this
  // Telegram. Its text is instructions, not an apology.
  not_linked: "login.tgNotLinked",
  bad_init_data: "login.tgBadInitData",
  telegram_not_configured: "login.tgNotConfigured",
  network: "login.tgNetwork",
};

export function TelegramLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const attempt = useCallback(async () => {
    setBusy(true);
    const r = await signInWithTelegram();
    if ("ok" in r) onSignedIn(); else { setError(r.error); setBusy(false); }
  }, [onSignedIn]);

  useEffect(() => { void attempt(); }, [attempt]);

  return (
    <div className="app tg-gate">
      <div className="card tg-gate-card">
        <div className="label">Money Track</div>
        {/* Three states, three different sentences. A single "щось пішло не так" would make
            "you have not linked this chat yet" — the expected case — read as a failure. */}
        {busy && <h2 className="tg-gate-title">{t("login.tgChecking")}</h2>}
        {!busy && error && (
          <>
            <h2 className="tg-gate-title">{t("login.tgCannotSignIn")}</h2>
            <p className="muted tg-gate-note">
              {REASONS[error] ? t(REASONS[error]) : t("login.oauthGenericError", { error })}
            </p>
            <div className="tg-gate-actions">
              {/*
                A plain link, opened outside: Telegram hands an external URL to a browser, which is
                where Google can actually complete a sign-in. Without the Telegram SDK there is no
                `openLink()` to call — and loading that script is what `script-src 'self'` forbids
                (`lib/telegram.ts`), so this is the whole mechanism, not a fallback for one.
                The ORIGIN, deliberately: the current URL carries `#tgWebAppData`, and handing a
                launch payload to a browser tab would be pasting a credential into the address bar.
              */}
              <a className="btn primary" href={window.location.origin} target="_blank" rel="noopener noreferrer">
                {t("login.tgOpenBrowser")}
              </a>
              {/* After linking in that tab, nothing tells this webview about it. */}
              <button className="btn" onClick={() => void attempt()}>{t("login.tgRetry")}</button>
            </div>
            {/* The code, small and last: it is for reporting, not for reading. */}
            <p className="muted tg-gate-code">{error}</p>
          </>
        )}
      </div>
    </div>
  );
}
