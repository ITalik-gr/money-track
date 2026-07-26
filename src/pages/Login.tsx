import { useT, type TranslationKey } from "../i18n/index.ts";

// Причини відмови від сервера (`/auth/google/callback` редіректить із `?error=`). Показуємо
// людський текст: «not_invited» — не помилка застосунку, а нормальний стан для invite-only,
// і мовчазний редірект на форму входу читався б як «щось зламалось».
const OAUTH_ERRORS: Record<string, TranslationKey> = {
  not_invited: "login.oauthNotInvited",
  email_not_verified: "login.oauthEmailNotVerified",
  google_oauth_not_configured: "login.oauthNotConfigured",
  bad_state: "login.oauthSessionExpired",
  bad_nonce: "login.oauthSessionExpired",
  token_exchange_failed: "login.oauthTokenFailed",
};

// Екран входу. Пароля більше немає (рішення користувача 2026-07-26) — Google єдиний шлях, тож
// на щасливому шляху цієї сторінки взагалі не видно: «Увійти» на лендінгу веде прямо в Google.
// Лишається вона заради ОДНОГО: показати причину, з якою повернув callback (`?error=`).
export function Login({ onBack }: { onBack?: () => void }) {
  const t = useT();

  const oauthError = new URLSearchParams(window.location.search).get("error");
  const oauthMessage = oauthError
    ? (OAUTH_ERRORS[oauthError] ? t(OAUTH_ERRORS[oauthError]) : t("login.oauthGenericError", { error: oauthError }))
    : null;

  return (
    <div className="app" style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
      <div className="card" style={{ padding: 24, width: "100%", maxWidth: 340 }}>
        {onBack && (
          <button className="btn ghost xs" style={{ marginLeft: -8, marginBottom: 8 }} onClick={onBack}>
            ← {t("login.back")}
          </button>
        )}
        <div className="label" style={{ marginBottom: 4 }}>Money Track</div>
        <h2 style={{ margin: "0 0 16px" }}>{t("login.title")}</h2>

        {oauthMessage && (
          <div className="neg" style={{ fontSize: 13, marginBottom: 12 }}>{oauthMessage}</div>
        )}

        {/* Звичайне посилання, а не fetch: OAuth — це редірект-флоу, і XHR тут лише зламав би
            його на CORS. */}
        <a className="btn primary" href="/auth/google/start" style={{ width: "100%", justifyContent: "center" }}>
          {t("login.googleBtn")}
        </a>

        <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>{t("login.inviteOnly")}</div>
      </div>
    </div>
  );
}
