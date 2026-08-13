import { useState } from "react";
import { getLocale, localeTag } from "../../i18n/locale.ts";
import { useT, type TranslationKey } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";
import { useGetCredentialsQuery, usePutCredentialMutation, useDeleteCredentialMutation } from "../../store/api.ts";
import { errText } from "../../lib/errors.ts";
import { ErrorNote } from "../ui/ErrorNote.tsx";

// «Ключі та підключення» — свій mono-токен і свій Anthropic-ключ (PLATFORM.md §4).
// Значення НІКОЛИ не приходить назад із сервера — навіть замасковане. Тому картка живе
// зі статусу: «збережено» + «востаннє звірено». Без другої дати протермінований токен
// виглядав би точно як робочий, і причину шукали б у зовсім іншому місці застосунку.
//
// ROADMAP L4: each key also carries a step-by-step "where do I get this" guide with the link.
// The landing only says WHICH two keys are needed; a new user then lands here and has to guess
// where they live — monobank hides its token behind a QR flow, and the Anthropic key needs a
// funded console account that is NOT the claude.ai subscription. Both are the kind of thing
// people ask a human about, so the answer belongs next to the input, not in an external doc.
const LABELS: Record<string, {
  titleKey: TranslationKey;
  hintKey: TranslationKey;
  placeholder: string;
  steps: TranslationKey[];
  docUrl: string;
  docLabel: string;
}> = {
  mono_token: {
    titleKey: "cred.monoTitle",
    hintKey: "cred.monoHint",
    placeholder: "u1AbC…",
    steps: ["cred.monoStep1", "cred.monoStep2", "cred.monoStep3", "cred.monoStep4"],
    docUrl: "https://api.monobank.ua/",
    docLabel: "api.monobank.ua",
  },
  // ⚠️ The hint says out loud that this reaches the ФОП account only. PrivatBank closed its
  // personal-card API in 2023 (BANKS.md §1), and a card that just says "PrivatBank" would promise
  // a person their cards — the one thing this integration cannot deliver.
  privat_credentials: {
    titleKey: "cred.privatTitle",
    hintKey: "cred.privatHint",
    placeholder: '{"id":"…","token":"…"}',
    steps: ["cred.privatStep1", "cred.privatStep2", "cred.privatStep3", "cred.privatStep4"],
    docUrl: "https://api.privatbank.ua/",
    docLabel: "api.privatbank.ua",
  },
  anthropic_api_key: {
    titleKey: "cred.anthropicTitle",
    hintKey: "cred.anthropicHint",
    placeholder: "sk-ant-…",
    steps: ["cred.anthropicStep1", "cred.anthropicStep2", "cred.anthropicStep3", "cred.anthropicStep4"],
    docUrl: "https://console.anthropic.com/settings/keys",
    docLabel: "console.anthropic.com",
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
  const [guide, setGuide] = useState<string | null>(null);

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
    // Full width (`set-full`): the two keys sit side by side with their step-by-step guides, which
    // half a column could not hold without wrapping every line. This is also the card a new user
    // has to act on first, so it earns the room.
    <div className="card set-card set-full">
      <div className="set-card-h"><Icon name="settings" size={16} />{t("cred.title")}</div>
      <p className="set-card-sub">{t("cred.subtitle")}</p>

      {error && <ErrorNote error={error} what={t("cred.errorWhat")} onRetry={refetch} />}
      {isLoading && <div className="muted" style={{ fontSize: 13 }}>{t("common.loading")}</div>}

      <div className="cred-cols">
        {(data?.secrets ?? []).map((s) => {
          const meta = LABELS[s.name];
          const title = meta ? t(meta.titleKey) : s.name;
          const hint = meta ? t(meta.hintKey) : "";
          const placeholder = meta?.placeholder ?? "";
          return (
            <div key={s.name} className="cred-col">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <strong style={{ fontSize: 14 }}>{title}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {s.set ? (s.last_ok_at ? t("cred.verifiedOn", { date: when(s.last_ok_at) }) : t("cred.savedNotVerified")) : t("cred.notSet")}
                </span>
              </div>
              <p className="set-card-sub" style={{ margin: "4px 0 8px" }}>{hint}</p>
              {meta && (
                <div className="cred-guide">
                  <button type="button" className="cred-guide-toggle" aria-expanded={guide === s.name}
                    onClick={() => setGuide((g) => (g === s.name ? null : s.name))}>
                    <Icon name="info" size={13} />
                    {guide === s.name ? t("cred.guideHide") : t("cred.guideShow")}
                  </button>
                  {guide === s.name && (
                    <>
                      <ol className="cred-steps">
                        {meta.steps.map((k) => <li key={k}>{t(k)}</li>)}
                      </ol>
                      {/* noreferrer as well as noopener: the target page has no business knowing
                          which app sent the user to fetch a key. */}
                      <a className="btn sm" href={meta.docUrl} target="_blank" rel="noreferrer noopener">
                        {meta.docLabel}<Icon name="arrowUpRight" size={13} />
                      </a>
                    </>
                  )}
                </div>
              )}
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

      {/* The three questions every new user asks before pasting a key (ROADMAP L4). Stated here
          rather than on the landing only, because this is the moment the key is handed over. */}
      <ul className="cred-facts">
        <li>{t("cred.factEncrypted")}</li>
        <li>{t("cred.factOwnBilling")}</li>
        <li>{t("cred.factNoAiKey")}</li>
      </ul>

      {note && <p className="set-card-sub" style={{ marginBottom: 0 }}>{note}</p>}
      {failed && <p className="neg" style={{ fontSize: 13, marginBottom: 0 }}>{failed}</p>}
    </div>
  );
}
