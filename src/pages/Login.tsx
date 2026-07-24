import { useState } from "react";
import { useLoginMutation } from "../store/api.ts";

// Причини відмови від сервера (`/auth/google/callback` редіректить із `?error=`). Показуємо
// людський текст: «not_invited» — не помилка застосунку, а нормальний стан для invite-only,
// і мовчазний редірект на форму входу читався б як «щось зламалось».
const OAUTH_ERRORS: Record<string, string> = {
  not_invited: "Цей акаунт не в списку запрошених. Попроси інвайт.",
  email_not_verified: "Google не підтвердив цю пошту.",
  google_oauth_not_configured: "Вхід через Google ще не налаштовано на сервері.",
  bad_state: "Сесія входу застаріла. Спробуй ще раз.",
  bad_nonce: "Сесія входу застаріла. Спробуй ще раз.",
  token_exchange_failed: "Google не віддав токен. Спробуй ще раз.",
};

// Повноекранний гейт входу. Показується, поки /api/me каже, що не залогінені.
export function Login() {
  const [password, setPassword] = useState("");
  const [login, { isLoading }] = useLoginMutation();
  const [error, setError] = useState<string | null>(null);

  const oauthError = new URLSearchParams(window.location.search).get("error");
  const oauthMessage = oauthError ? (OAUTH_ERRORS[oauthError] ?? `Помилка входу: ${oauthError}`) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await login(password).unwrap();
    } catch {
      setError("Невірний пароль");
    }
  }

  return (
    <div className="app" style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
      <div className="card" style={{ padding: 24, width: "100%", maxWidth: 340 }}>
        <div className="label" style={{ marginBottom: 4 }}>Money Track</div>
        <h2 style={{ margin: "0 0 16px" }}>Вхід</h2>

        {oauthMessage && (
          <div className="neg" style={{ fontSize: 13, marginBottom: 12 }}>{oauthMessage}</div>
        )}

        {/* Основний шлях. Звичайне посилання, а не fetch: OAuth — це редірект-флоу,
            і XHR тут лише зламав би його на CORS. */}
        <a className="btn primary" href="/auth/google/start" style={{ width: "100%", justifyContent: "center" }}>
          Увійти через Google
        </a>

        <div className="muted" style={{ fontSize: 12, textAlign: "center", margin: "16px 0 12px" }}>
          або паролем
        </div>

        <form onSubmit={submit}>
          <div className="stack">
            <input
              type="password"
              placeholder="Пароль"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <div className="neg" style={{ fontSize: 13 }}>{error}</div>}
            <button className="btn" type="submit" disabled={!password || isLoading}>
              {isLoading ? "…" : "Увійти"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
