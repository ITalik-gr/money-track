// Центр сповіщень (ROADMAP §Черга 2, v1 in-app). Стрічка того, що система «хоче сказати»:
// готові репорти, дедлайни списань, аномалії темпу, бюджети, подорожчання, провал ліквідності.
// Усі цифри рахує бекенд по канону `stats.ts` — тут лише подача.
import { useMemo, useState } from "react";
import { getLocale, dateFmt } from "../i18n/locale.ts";
import { useT, translate, useLocale } from "../i18n/index.ts";
import { Link } from "react-router-dom";
import {
  useGetNotificationsQuery, useGetNotifPrefsQuery, useSetNotifPrefsMutation,
  useMarkNotificationsReadMutation, useMarkAllNotificationsReadMutation,
  useClearNotificationsMutation, useGenerateNotificationsMutation,
} from "../store/api.ts";
import type { Notification, NotifKind } from "../store/api.ts";
import { Icon } from "../components/ui/Icon.tsx";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import { renderNotif, type NotifLocale, type NotifParams } from "../../shared/notif-i18n.ts";

// Compose a feed row's text: templated rows (P3.3) re-render in the CURRENT locale from
// key+params, so switching language retranslates the whole feed live; `ai`/legacy rows have
// no template and fall back to the stored title/body.
function notifText(n: Notification): { title: string; body: string | null } {
  if (n.notif_key) {
    const loc: NotifLocale = getLocale() === "en" ? "en" : "uk";
    let params: NotifParams = {};
    try { params = n.notif_params ? JSON.parse(n.notif_params) as NotifParams : {}; } catch { /* fall back to defaults */ }
    return renderNotif(loc, n.notif_key, params);
  }
  return { title: n.title, body: n.body };
}

// Тип події → ключ підпису, іконка й куди веде клік. Один вокабуляр на всю сторінку.
const KIND_META: Record<NotifKind, { labelKey:
  "notif.kind.ai" | "notif.kind.report" | "notif.kind.deadline" | "notif.kind.anomaly" |
  "notif.kind.budget" | "notif.kind.price_up" | "notif.kind.liquidity" | "notif.kind.big_tx" |
  "notif.kind.duplicate" | "notif.kind.health_drop" | "notif.kind.goal_risk" | "notif.kind.dead_sub" |
  "notif.kind.win" | "notif.kind.todo"; icon: string }> = {
  ai: { labelKey: "notif.kind.ai", icon: "spark" },
  report: { labelKey: "notif.kind.report", icon: "report" },
  deadline: { labelKey: "notif.kind.deadline", icon: "calendar" },
  anomaly: { labelKey: "notif.kind.anomaly", icon: "stats" },
  budget: { labelKey: "notif.kind.budget", icon: "plan" },
  price_up: { labelKey: "notif.kind.price_up", icon: "swap" },
  liquidity: { labelKey: "notif.kind.liquidity", icon: "alert" },
  big_tx: { labelKey: "notif.kind.big_tx", icon: "tx" },
  duplicate: { labelKey: "notif.kind.duplicate", icon: "copy" },
  health_drop: { labelKey: "notif.kind.health_drop", icon: "advisor" },
  goal_risk: { labelKey: "notif.kind.goal_risk", icon: "target" },
  dead_sub: { labelKey: "notif.kind.dead_sub", icon: "repeat" },
  win: { labelKey: "notif.kind.win", icon: "check" },
  todo: { labelKey: "notif.kind.todo", icon: "tag" },
};
const KINDS = Object.keys(KIND_META) as NotifKind[];

const dayFmt = dateFmt({ day: "numeric", month: "long" });
const timeFmt = dateFmt({ hour: "2-digit", minute: "2-digit" });

// Заголовок групи: «Сьогодні» / «Вчора» / дата. Стрічку читають зверху вниз за днями.
function dayLabel(unix: number): string {
  const d = new Date(unix * 1000);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diff === 0) return translate(getLocale(), "notif.today");
  if (diff === 1) return translate(getLocale(), "notif.yesterday");
  return dayFmt.format(d);
}

/**
 * Куди веде подія.
 *
 * Сповіщення без переходу — це тупик: воно каже «бюджет вичерпано», а далі користувач шукає
 * потрібний екран руками. Тому маршрут дає СПОЧАТКУ сутність (`entity_type` + `entity_id`), а
 * коли її немає — сам ВИД події: у ліквідності чи просідання здоровʼя немає рядка в базі, але
 * екран, де про це написано детально, цілком є.
 *
 * `null` лишається тільки для того, чого ми справді не вміємо показати — такий рядок
 * лишається кнопкою «позначити прочитаним».
 */
function linkFor(n: Notification): string | null {
  if (n.entity_type === "report" && n.entity_id) return `/reports/${n.entity_id}`;
  if (n.entity_type === "tx" && n.entity_id) return `/tx/${n.entity_id}`;
  if (n.entity_type === "planned") return "/subs";
  if (n.entity_type === "account") return "/accounts";
  if (n.entity_type === "goal") return "/goals";
  if (n.entity_type === "advice") return "/advisor";
  if (n.entity_type === "budget_plan") return "/plan";
  if (n.entity_type === "category" && n.entity_id) {
    // Бюджет — це ліміт, і живе він у Плані; темп/перемога — це витрати, тож ведемо у список
    // операцій цієї категорії. `catp`, а не `cat`: `entity_id` — вже рол-ап у батька (§Канон),
    // тож фільтр має брати категорію РАЗОМ із підкатегоріями.
    return n.kind === "budget" ? "/plan" : `/tx?catp=${n.entity_id}`;
  }
  // Події без власної сутності. Порадник — єдиний екран, де подушка, runway й індекс здоровʼя
  // розібрані числами; спостереження моделі теж родом звідти (той самий знімок фінансів).
  if (n.kind === "liquidity" || n.kind === "health_drop" || n.kind === "ai") return "/advisor";
  if (n.kind === "todo") return "/tx";   // «багато без категорії» → саме там їх і розбирають
  return null;
}

function Row({ n, onRead }: { n: Notification; onRead: (id: number) => void }) {
  useLocale();               // re-render this row when the language switches (P3.3)
  const meta = KIND_META[n.kind];
  const to = linkFor(n);
  const text = notifText(n);
  const body = (
    <>
      <span className={`nt-ico ${n.severity}`}><Icon name={meta?.icon ?? "info"} size={16} /></span>
      <span className="nt-body">
        <span className="nt-title">{text.title}</span>
        {text.body && <span className="nt-text">{text.body}</span>}
      </span>
      <span className="nt-time">{timeFmt.format(n.created_at * 1000)}</span>
      {/* Стрілка — єдина ознака, що рядок кудись веде. Без неї «перейти» й «просто позначити»
          виглядають однаково, і про перехід дізнається лише той, хто навмання клікне. */}
      {to && <span className="nt-go" aria-hidden="true">→</span>}
    </>
  );
  const cls = `nt-row ${n.read_at ? "read" : "unread"}${to ? " nt-link" : ""}`;
  // Клік = «прочитано» + перехід. Позначаємо ЗАВЖДИ, і у випадку з переходом теж: подію,
  // яку вже відкрили, лічильник непрочитаних більше рахувати не має.
  // Подія без сутності лишається кнопкою — вона вміє рівно одне, позначити прочитаним.
  return to
    ? <Link to={to} className={cls} onClick={() => onRead(n.id)}>{body}</Link>
    : <button type="button" className={cls} onClick={() => onRead(n.id)}>{body}</button>;
}

export function Notifications() {
  const t = useT();
  const [kind, setKind] = useState<NotifKind | null>(null);
  const [showPrefs, setShowPrefs] = useState(false);
  const { data, error, isLoading, refetch } = useGetNotificationsQuery({ kind });
  const { data: prefs } = useGetNotifPrefsQuery();
  const [setPrefs] = useSetNotifPrefsMutation();
  const [markRead] = useMarkNotificationsReadMutation();
  const [markAll] = useMarkAllNotificationsReadMutation();
  const [clearAll] = useClearNotificationsMutation();
  const [generate, { isLoading: generating }] = useGenerateNotificationsMutation();

  const items = data?.items ?? [];
  const groups = useMemo(() => {
    const out: { day: string; items: Notification[] }[] = [];
    for (const n of items) {
      const day = dayLabel(n.created_at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(n);
      else out.push({ day, items: [n] });
    }
    return out;
  }, [items]);

  const read = (id: number) => { void markRead([id]); };

  const run = async () => {
    try {
      const r = await generate().unwrap();
      const bits = [r.created ? t("notif.newEventsCount", { n: r.created }) : t("notif.noNewEvents")];
      if (r.pushed) bits.push(t("notif.pushedToTg", { n: r.pushed }));
      if (r.pruned) bits.push(t("notif.prunedOld", { n: r.pruned }));
      toast.success(bits.join(" · "));
      // Гілка впала (напр. таблиця відсутня на remote) — кажемо це вголос, не мовчимо.
      if (r.skipped.length) toast.error(t("notif.failedItems", { list: r.skipped.join("; ") }));
    } catch (e) { toast.error(errText(e)); }
  };

  const wipe = async () => {
    if (!confirm(t("notif.clearAllConfirm"))) return;
    try { await clearAll().unwrap(); toast.success(t("notif.cleared")); }
    catch (e) { toast.error(errText(e)); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("notif.title")}</div>
          <div className="sub">{t("notif.sub")}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm" disabled={generating} onClick={run}>
            <Icon name="spark" size={15} />{generating ? t("notif.checking") : t("notif.checkNow")}
          </button>
          <button className="btn sm" onClick={() => setShowPrefs((v) => !v)} aria-expanded={showPrefs}>
            <Icon name="settings" size={15} />{t("notif.types")}
          </button>
        </div>
      </div>

      {showPrefs && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="section-head"><span>{t("notif.whichToCollect")}</span></div>
          <p className="ai-block-hint">{t("notif.prefsHint")}</p>
          <div className="nt-prefs">
            {KINDS.map((k) => (
              <label key={k} className="nt-pref">
                <input
                  type="checkbox"
                  checked={prefs?.[k] ?? true}
                  onChange={(e) => { void setPrefs({ [k]: e.target.checked }); }}
                />
                <Icon name={KIND_META[k].icon} size={14} />
                {t(KIND_META[k].labelKey)}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="chips" role="tablist" aria-label={t("notif.filterByType")}>
        <button type="button" className={`chip ${kind === null ? "on" : ""}`} onClick={() => setKind(null)}>
          {t("notif.all")}{data ? ` · ${data.unread}` : ""}
        </button>
        {KINDS.map((k) => (
          <button key={k} type="button" className={`chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
            <Icon name={KIND_META[k].icon} size={13} />{t(KIND_META[k].labelKey)}
          </button>
        ))}
      </div>

      {/* §Обробка помилок: сторінка зі стрічкою МУСИТЬ мати гілку помилки — інакше
          збій і «подій немає» виглядають однаково. */}
      <ErrorNote error={error} what={t("notif.errorWhat")} onRetry={refetch} />

      {!error && !isLoading && items.length === 0 && (
        <div className="card empty">
          {kind ? t("notif.emptyOfType") : t("notif.emptyAll")}
        </div>
      )}

      {groups.length > 0 && (
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginBottom: 10 }}>
          {(data?.unread ?? 0) > 0 && (
            <button className="btn sm" onClick={() => { void markAll(); }}>
              <Icon name="check" size={14} />{t("notif.markAllRead")}
            </button>
          )}
          <button className="btn sm" onClick={wipe}><Icon name="trash" size={14} />{t("notif.clear")}</button>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.day} className="nt-group">
          <div className="nt-day">{g.day}</div>
          <div className="card flush nt-list">
            {g.items.map((n) => <Row key={n.id} n={n} onRead={read} />)}
          </div>
        </div>
      ))}
    </>
  );
}
