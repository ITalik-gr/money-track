/**
 * §D1 — Telegram у Налаштуваннях, тепер для ВСІХ юзерів.
 *
 * Раніше картка була під `isOwner`: бот шле в один глобальний чат, і показувати решті кнопки,
 * які або дадуть 403, або — гірше — виглядатимуть так, ніби налаштовують ТВІЙ бот, було б
 * обіцянкою, якої продукт не виконує. Тепер адресат персональний (`tgTarget` на сервері), тож
 * картку видно всім; owner-only лишилась ЛИШЕ реєстрація вебхука — це справді один глобальний
 * ресурс, а не чат конкретної людини.
 */
import { useState } from "react";
import { Icon } from "../ui/Icon.tsx";
import {
  useGetTelegramLinkQuery,
  useLinkTelegramMutation,
  useUnlinkTelegramMutation,
  useRegisterTelegramMutation,
  useTgProactiveMutation,
  useScanAlertsMutation,
} from "../../store/api.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { useT } from "../../i18n/index.ts";

export function TelegramCard({ isOwner }: { isOwner: boolean }) {
  const t = useT();
  const { data: state, error, refetch } = useGetTelegramLinkQuery();
  const [link, linkState] = useLinkTelegramMutation();
  const [unlink] = useUnlinkTelegramMutation();
  const [registerTelegram, tgState] = useRegisterTelegramMutation();
  const [tgProactive, tgPushState] = useTgProactiveMutation();
  const [scanAlerts, scanState] = useScanAlertsMutation();
  // Deep-link живе 15 хвилин, тож показуємо його, а не відкриваємо мовчки: попап-блокери
  // ковтають програмний `window.open`, і кнопка виглядала б як така, що нічого не зробила.
  const [deepLink, setDeepLink] = useState<string | null>(null);

  const configured = state?.configured ?? false;
  const linked = state?.linked ?? false;

  async function connect() {
    try {
      const r = await link().unwrap();
      setDeepLink(r.url);
      window.open(r.url, "_blank", "noopener");
    } catch (e) { toast.error(errText(e)); }
  }

  async function disconnect() {
    try {
      await unlink().unwrap();
      setDeepLink(null);
      toast.success(t("setup.tgUnlinked"));
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    // NOT `set-full` any more (2026-08-14). The comment on the settings page has said since §PUSH
    // that this card and "browser notifications" belong side by side — they answer one question
    // ("tell me when something matters without making me open the app") and a person needs at most
    // one of them. Full width put Telegram on its own row and left the push card paired with the
    // feedback form instead: twice the height, and a visible hole under the short one.
    <div className="card set-card">
      <div className="set-card-h"><Icon name="bell" size={16} />Telegram</div>
      <p className="set-card-sub">{t("setup.telegramSub")}</p>

      {!configured && <p className="set-card-sub">{t("setup.tgNotConfigured")}</p>}

      {configured && (
        <>
          <p className="set-card-sub">
            {linked
              ? t("setup.tgLinked")
              : state?.owner_fallback ? t("setup.tgOwnerFallback") : t("setup.tgNotLinked")}
          </p>
          {/*
            What the bot LOOKS like, said here because it is invisible from this screen (2026-08-21).
            The strip and the ⌘ menu attach themselves from the next update (`tg-surface.ts`), but a
            chat linked before that shipped shows neither until something arrives — so the recovery
            («send /help») belongs next to the state that needs it, not in a changelog.
          */}
          {linked && <p className="set-card-sub">{t("setup.tgButtonsNote")}</p>}
          {/*
            The primary slot belongs to the action that matches the STATE (2026-08-14). While a
            chat was connected the loudest button on the card was "connect a different chat" — the
            one action you would take almost never — and it sat above four more buttons of equal
            weight. Connected: relinking and unlinking are both maintenance, so neither is primary.
          */}
          <div className={linked ? "row tg-actions" : "stack"}>
            <button className={linked ? "btn sm" : "btn primary"} disabled={linkState.isLoading} onClick={connect}>
              {linked ? t("setup.tgRelink") : t("setup.tgConnectMine")}
            </button>
            {linked && <button className="btn sm" onClick={disconnect}>{t("setup.tgUnlink")}</button>}
          </div>
          {deepLink && (
            <p className="set-card-sub" style={{ marginTop: 10 }}>
              {t("setup.tgLinkHint")}{" "}
              <a href={deepLink} target="_blank" rel="noopener noreferrer">{deepLink}</a>{" "}
              <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => refetch()}>{t("setup.tgLinkDone")}</button>
            </p>
          )}
        </>
      )}

      {/* Помилка окремо: без неї «не налаштовано» і «запит упав» виглядають однаково. */}
      {error != null && <p className="set-card-sub" style={{ color: "var(--neg)" }}>{errText(error)}</p>}

      {/*
        Folded (2026-08-14). Two test buttons and — for the owner — a global webhook registration
        are things you press once while setting up or when something looks broken. Stacked open at
        full width they made a five-button wall whose subject ("where do my pushes go") was the
        one line of text above it.
      */}
      <details className="tg-more">
        <summary className="disclose">{t("setup.tgMore")}</summary>
      <div className="stack" style={{ marginTop: 12 }}>
        <button
          className="btn sm"
          disabled={tgPushState.isLoading}
          onClick={async () => {
            const r = await tgProactive().unwrap();
            if (r.sent) toast.success(t("setup.tgPushSent"));
            else toast.info(t("setup.tgPushNotSent", { reason: r.reason ?? t("setup.tgNotConfigured") }));
          }}
        >
          {t("setup.tgTestSummary")}
        </button>
        <button
          className="btn sm"
          disabled={scanState.isLoading}
          onClick={async () => {
            const r = await scanAlerts().unwrap();
            if (r.sent > 0) toast.success(t("setup.alertsSent", { n: r.sent }));
            else toast.info(t("setup.noSignificantTx"));
          }}
        >
          {t("setup.tgTestScan")}
        </button>
        {/* Owner-only і на сервері: це реєстрація ОДНОГО глобального вебхука бота, а не
            налаштування чату конкретної людини. */}
        {isOwner && (
          <button
            className="btn sm"
            disabled={tgState.isLoading}
            onClick={async () => {
              const r = await registerTelegram().unwrap();
              if (r.error) toast.error(t("setup.tgError", { error: r.error })); else toast.success(t("setup.tgConnected"));
            }}
          >
            {t("setup.connectTg")}
          </button>
        )}
      </div>
      </details>
    </div>
  );
}
