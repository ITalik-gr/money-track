// Центр сповіщень (ROADMAP §Черга 2, v1 in-app). Стрічка того, що система «хоче сказати»:
// готові репорти, дедлайни списань, аномалії темпу, бюджети, подорожчання, провал ліквідності.
// Усі цифри рахує бекенд по канону `stats.ts` — тут лише подача.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  useGetNotificationsQuery, useGetNotifPrefsQuery, useSetNotifPrefsMutation,
  useMarkNotificationsReadMutation, useMarkAllNotificationsReadMutation,
  useClearNotificationsMutation, useGenerateNotificationsMutation,
} from "../store/api.ts";
import type { Notification, NotifKind } from "../store/api.ts";
import { Icon } from "../components/Icon.tsx";
import { ErrorNote } from "../components/ErrorNote.tsx";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";

// Тип події → підпис, іконка й куди веде клік. Один вокабуляр на всю сторінку.
const KIND_META: Record<NotifKind, { label: string; icon: string }> = {
  ai: { label: "AI-спостереження", icon: "spark" },
  report: { label: "Репорти", icon: "report" },
  deadline: { label: "Дедлайни", icon: "calendar" },
  anomaly: { label: "Аномалії", icon: "stats" },
  budget: { label: "Бюджети", icon: "plan" },
  price_up: { label: "Подорожчання", icon: "swap" },
  liquidity: { label: "Ліквідність", icon: "alert" },
  big_tx: { label: "Великі витрати", icon: "tx" },
  duplicate: { label: "Дублі списань", icon: "copy" },
  health_drop: { label: "Індекс здоровʼя", icon: "advisor" },
  goal_risk: { label: "Цілі", icon: "target" },
  dead_sub: { label: "Мертві підписки", icon: "repeat" },
  win: { label: "Перемоги", icon: "check" },
  todo: { label: "Треба зробити", icon: "tag" },
};
const KINDS = Object.keys(KIND_META) as NotifKind[];

const dayFmt = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long" });
const timeFmt = new Intl.DateTimeFormat("uk-UA", { hour: "2-digit", minute: "2-digit" });

// Заголовок групи: «Сьогодні» / «Вчора» / дата. Стрічку читають зверху вниз за днями.
function dayLabel(unix: number): string {
  const d = new Date(unix * 1000);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diff === 0) return "Сьогодні";
  if (diff === 1) return "Вчора";
  return dayFmt.format(d);
}

/** Куди веде подія. null = нікуди (ліквідність — це стан, не сутність). */
function linkFor(n: Notification): string | null {
  if (n.entity_type === "report" && n.entity_id) return `/reports/${n.entity_id}`;
  if (n.entity_type === "tx" && n.entity_id) return `/tx/${n.entity_id}`;
  if (n.entity_type === "planned") return "/subs";
  if (n.entity_type === "category") return "/stats";
  if (n.entity_type === "goal") return "/goals";
  return null;
}

function Row({ n, onRead }: { n: Notification; onRead: (id: number) => void }) {
  const meta = KIND_META[n.kind];
  const to = linkFor(n);
  const body = (
    <>
      <span className={`nt-ico ${n.severity}`}><Icon name={meta?.icon ?? "info"} size={16} /></span>
      <span className="nt-body">
        <span className="nt-title">{n.title}</span>
        {n.body && <span className="nt-text">{n.body}</span>}
      </span>
      <span className="nt-time">{timeFmt.format(n.created_at * 1000)}</span>
    </>
  );
  const cls = `nt-row ${n.read_at ? "read" : "unread"}`;
  // Клік = «прочитано» + перехід. Подія без сутності лишається кнопкою (лише позначити).
  return to
    ? <Link to={to} className={cls} onClick={() => onRead(n.id)}>{body}</Link>
    : <button type="button" className={cls} onClick={() => onRead(n.id)}>{body}</button>;
}

export function Notifications() {
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
      const bits = [r.created ? `нових подій: ${r.created}` : "нових подій немає"];
      if (r.pushed) bits.push(`у Telegram: ${r.pushed}`);
      if (r.pruned) bits.push(`прибрано старих: ${r.pruned}`);
      toast.success(bits.join(" · "));
      // Гілка впала (напр. таблиця відсутня на remote) — кажемо це вголос, не мовчимо.
      if (r.skipped.length) toast.error(`Не порахувалось: ${r.skipped.join("; ")}`);
    } catch (e) { toast.error(errText(e)); }
  };

  const wipe = async () => {
    if (!confirm("Очистити всю стрічку сповіщень?")) return;
    try { await clearAll().unwrap(); toast.success("Стрічку очищено"); }
    catch (e) { toast.error(errText(e)); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">Сповіщення</div>
          <div className="sub">
            Що система помітила у твоїх грошах: готові репорти, дедлайни списань, аномалії темпу,
            бюджети й провали ліквідності.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm" disabled={generating} onClick={run}>
            <Icon name="spark" size={15} />{generating ? "Перевіряю…" : "Перевірити зараз"}
          </button>
          <button className="btn sm" onClick={() => setShowPrefs((v) => !v)} aria-expanded={showPrefs}>
            <Icon name="settings" size={15} />Типи
          </button>
        </div>
      </div>

      {showPrefs && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="section-head"><span>Які події збирати</span></div>
          <p className="ai-block-hint">
            Вимкнений тип більше не генерується добовим прогоном. Уже наявні події лишаються в стрічці.
          </p>
          <div className="nt-prefs">
            {KINDS.map((k) => (
              <label key={k} className="nt-pref">
                <input
                  type="checkbox"
                  checked={prefs?.[k] ?? true}
                  onChange={(e) => { void setPrefs({ [k]: e.target.checked }); }}
                />
                <Icon name={KIND_META[k].icon} size={14} />
                {KIND_META[k].label}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="chips" role="tablist" aria-label="Фільтр за типом">
        <button type="button" className={`chip ${kind === null ? "on" : ""}`} onClick={() => setKind(null)}>
          Усі{data ? ` · ${data.unread}` : ""}
        </button>
        {KINDS.map((k) => (
          <button key={k} type="button" className={`chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
            <Icon name={KIND_META[k].icon} size={13} />{KIND_META[k].label}
          </button>
        ))}
      </div>

      {/* §Обробка помилок: сторінка зі стрічкою МУСИТЬ мати гілку помилки — інакше
          збій і «подій немає» виглядають однаково. */}
      <ErrorNote error={error} what="сповіщення" onRetry={refetch} />

      {!error && !isLoading && items.length === 0 && (
        <div className="card empty">
          {kind ? "Подій цього типу ще немає." : "Поки тихо. Стрічка оновлюється щоранку — або тисни «Перевірити зараз»."}
        </div>
      )}

      {groups.length > 0 && (
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginBottom: 10 }}>
          {(data?.unread ?? 0) > 0 && (
            <button className="btn sm" onClick={() => { void markAll(); }}>
              <Icon name="check" size={14} />Позначити все прочитаним
            </button>
          )}
          <button className="btn sm" onClick={wipe}><Icon name="trash" size={14} />Очистити</button>
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
