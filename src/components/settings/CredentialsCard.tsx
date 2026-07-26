import { useState } from "react";
import { getLocale, localeTag } from "../i18n/locale.ts";
import { useT, type TranslationKey } from "../i18n/index.ts";
import { Icon } from "./Icon.tsx";
import { useGetCredentialsQuery, usePutCredentialMutation, useDeleteCredentialMutation } from "../store/api.ts";
import { errText } from "../lib/errors.ts";
import { ErrorNote } from "./ErrorNote.tsx";

// «Ключі та підключення» — свій mono-токен і свій Anthropic-ключ (PLATFORM.md §4).
// Значення НІКОЛИ не приходить назад із сервера — навіть замасковане. Тому картка живе
// зі статусу: «збережено» + «востаннє звірено». Без другої дати протермінований токен
// виглядав би точно як робочий, і причину шукали б у зовсім іншому місці застосунку.
const LABELS: Record<string, { titleKey: TranslationKey; hintKey: TranslationKey; placeholder: string }> = {
  mono_token: {
    titleKey: "cred.monoTitle",
    hintKey: "cred.monoHint",
    placeholder: "u1AbC…",
  },
  anthropic_api_key: {
    titleKey: "cred.anthropicTitle",
    hintKey: "cred.anthropicHint",
    placeholder: "sk-ant-…",
  },
};

function when(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString(localeTag(getLocale()), { day: "numeric", month: "short", year: "numeric" });
}

export function CredentialsCard() {
  const t = useT();
  const { data, isLoading, error, refetch } = useGetCredentialsQuery();
  const [put, putState] = usePutCredentialMutation();
  const [del] = useDeleteCredentialMutation();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function save(name: string) {
    const value = (drafts[name] ?? "").trim();
    if (!value) return;
    setNote(null);
    setFailed(null);
    try {
      const res = await put({ name, value }).unwrap();
      setDrafts((d) => ({ ...d, [name]: "" }));
      // `detail` приходить, коли зберегли БЕЗ звірки (напр. mono обмежив 1 запит/60с) —
      // це не помилка, але й не «перевірено», тож кажемо прямо.
      setNote(res.detail ?? (res.verified ? t("cred.savedVerified") : t("cred.saved")));
    } catch (e) {
      setFailed(errText(e));
    }
  }

  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="settings" size={16} />{t("cred.title")}</div>
      <p className="set-card-sub">{t("cred.subtitle")}</p>

      {error && <ErrorNote error={error} what={t("cred.errorWhat")} onRetry={refetch} />}
      {isLoading && <div className="muted" style={{ fontSize: 13 }}>{t("common.loading")}</div>}

      <div className="stack">
        {(data?.secrets ?? []).map((s) => {
          const meta = LABELS[s.name];
          const title = meta ? t(meta.titleKey) : s.name;
          const hint = meta ? t(meta.hintKey) : "";
          const placeholder = meta?.placeholder ?? "";
          return (
            <div key={s.name}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <strong style={{ fontSize: 14 }}>{title}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {s.set ? (s.last_ok_at ? t("cred.verifiedOn", { date: when(s.last_ok_at) }) : t("cred.savedNotVerified")) : t("cred.notSet")}
                </span>
              </div>
              <p className="set-card-sub" style={{ margin: "4px 0 8px" }}>{hint}</p>
              <div className="row" style={{ gap: 8 }}>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={s.set ? t("cred.replacePlaceholder") : placeholder}
                  value={drafts[s.name] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.name]: e.target.value }))}
                  style={{ flex: 1 }}
                />
                <button
                  className="btn sm"
                  onClick={() => save(s.name)}
                  disabled={!(drafts[s.name] ?? "").trim() || putState.isLoading}
                >
                  {putState.isLoading ? "…" : t("common.save")}
                </button>
                {s.set && (
                  <button className="btn sm ghost danger-text" onClick={() => del(s.name)}>
                    {t("cred.removeBtn")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {note && <p className="set-card-sub" style={{ marginBottom: 0 }}>{note}</p>}
      {failed && <p className="neg" style={{ fontSize: 13, marginBottom: 0 }}>{failed}</p>}
    </div>
  );
}
