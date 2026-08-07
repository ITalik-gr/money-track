import { useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { Icon } from "../ui/Icon.tsx";
import {
  useGetPushStatusQuery, useSubscribePushMutation, useUnsubscribePushMutation, useTestPushMutation,
} from "../../store/api.ts";
import { currentEndpoint, pushSupport, subscribe, unsubscribe, type PushSupport } from "../../lib/push.ts";

/**
 * Browser notifications (§PUSH).
 *
 * Sits beside the Telegram card because they answer the same question — "tell me when something
 * matters without me opening the app" — and a user needs at most one of them. Telegram is better
 * on a phone that has it and needs no permission prompt; this one needs no Telegram.
 *
 * ⚠️ The states here are not decoration. Push has four different ways of being unavailable and
 * they need four different sentences: the deployment has no keys, the browser cannot do it at all,
 * iOS can but only once installed to the home screen, and the user has already refused. A single
 * disabled button would leave all four looking like a bug.
 */
export function PushCard() {
  const t = useT();
  const { data: status } = useGetPushStatusQuery();
  const [sub, subState] = useSubscribePushMutation();
  const [unsub] = useUnsubscribePushMutation();
  const [test, testState] = useTestPushMutation();

  const [support, setSupport] = useState<PushSupport>("unsupported");
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  // Read the browser's own view once mounted — `Notification.permission` and the existing
  // subscription are facts about THIS device, and the server only knows how many devices exist.
  useEffect(() => {
    setSupport(pushSupport());
    if ("Notification" in window) setDenied(Notification.permission === "denied");
    void currentEndpoint().then(setEndpoint);
  }, []);

  async function enable() {
    try {
      if (!status?.key) return;
      const ep = await subscribe(status.key);
      await sub(ep).unwrap();
      setEndpoint(ep);
      toast.success(t("push.enabled"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "denied") { setDenied(true); toast.error(t("push.deniedToast")); return; }
      if (msg === "dismissed") return; // the user closed the prompt — not an error, say nothing
      toast.error(errText(e));
    }
  }

  async function disable() {
    try {
      const ep = await unsubscribe();
      // Tell the server even if the browser had nothing to remove: the row can outlive the
      // subscription (a wiped profile, a reinstalled browser), and it is the row that gets pushed.
      await unsub(ep ?? endpoint ?? "").unwrap().catch(() => {});
      setEndpoint(null);
      toast.success(t("push.disabled"));
    } catch (e) {
      toast.error(errText(e));
    }
  }

  const unavailable: string | null =
    status && !status.configured ? t("push.notConfigured")
      : support === "needs-install" ? t("push.needsInstall")
        : support === "unsupported" ? t("push.unsupported")
          : denied ? t("push.denied")
            : null;

  return (
    <div className="card set-card">
      <div className="set-card-h"><Icon name="bell" size={16} />{t("push.title")}</div>
      <p className="set-card-sub">{t("push.sub")}</p>

      {unavailable && <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>{unavailable}</div>}

      {!unavailable && (
        <div className="stack" style={{ marginTop: 4 }}>
          {endpoint
            ? <button className="btn" onClick={disable}>{t("push.disable")}</button>
            : <button className="btn primary" disabled={subState.isLoading} onClick={enable}>{t("push.enable")}</button>}

          {/* Без цієї кнопки перший раз, коли людина дізнається, що пуші не працюють, — це ніч,
              коли вони мали спрацювати. */}
          {endpoint && (
            <button className="btn ghost sm" disabled={testState.isLoading} onClick={async () => {
              try {
                const r = await test().unwrap();
                toast.success(r.sent > 0 ? t("push.testSent", { n: r.sent }) : t("push.testNone"));
              } catch (e) { toast.error(errText(e)); }
            }}>
              {testState.isLoading ? t("push.testing") : t("push.test")}
            </button>
          )}
        </div>
      )}

      {/* Кількість пристроїв, а не «увімкнено/вимкнено»: підписка належить БРАУЗЕРУ, і людина, що
          ввімкнула їх на телефоні, інакше побачила б на ноутбуці «вимкнено» й вирішила, що зламалось. */}
      {!!status?.subscriptions && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          {t("push.deviceCount", { n: status.subscriptions })}
        </div>
      )}
    </div>
  );
}
