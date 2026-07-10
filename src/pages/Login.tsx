import { useState } from "react";
import { useLoginMutation } from "../store/api.ts";

// Повноекранний пароль-гейт. Показується, поки /api/me каже, що не залогінені.
export function Login() {
  const [password, setPassword] = useState("");
  const [login, { isLoading }] = useLoginMutation();
  const [error, setError] = useState<string | null>(null);

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
      <form className="card" style={{ padding: 24, width: "100%", maxWidth: 340 }} onSubmit={submit}>
        <div className="label" style={{ marginBottom: 4 }}>Money Track</div>
        <h2 style={{ margin: "0 0 16px" }}>Вхід</h2>
        <div className="stack">
          <input
            type="password"
            autoFocus
            placeholder="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <div className="neg" style={{ fontSize: 13 }}>{error}</div>}
          <button className="btn primary" type="submit" disabled={!password || isLoading}>
            {isLoading ? "…" : "Увійти"}
          </button>
        </div>
      </form>
    </div>
  );
}
