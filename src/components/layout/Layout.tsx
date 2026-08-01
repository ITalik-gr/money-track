import { useState } from "react";
import { NavLink, Outlet, Link } from "react-router-dom";
import { Icon } from "../ui/Icon.tsx";
import { Toaster } from "../ui/Toaster.tsx";
import { CommandPalette, openCommandPalette } from "./CommandPalette.tsx";
import { AiJobChip } from "./AiJobs.tsx";
import { useGetNotificationsQuery, useGetMeQuery, useLogoutMutation, useGetPeriodModeQuery, useSetPeriodModeMutation } from "../../store/api.ts";
import { useLocale, useT } from "../../i18n/index.ts";
import type { Locale } from "../../i18n/index.ts";
import type { TranslationKey } from "../../i18n/index.ts";

// Пункти навігації. desktop=сайдбар (усі), mobile=нижній таб-бар (тільки core).
// `label` is a translation key resolved at render (see PLATFORM.md §12) — not a literal.
// `tab` is the SHORT label for the bottom bar, where six items share one phone width.
const items: { to: string; label: TranslationKey; tab?: TranslationKey; icon: string; end: boolean; core: boolean }[] = [
  { to: "/", label: "nav.overview", tab: "nav.tab.overview", icon: "overview", end: true, core: true },
  { to: "/tx", label: "nav.tx", tab: "nav.tab.tx", icon: "tx", end: false, core: true },
  { to: "/accounts", label: "nav.accounts", icon: "accounts", end: false, core: false },
  { to: "/stats", label: "nav.stats", tab: "nav.tab.stats", icon: "stats", end: false, core: true },
  { to: "/reports", label: "nav.reports", icon: "report", end: false, core: false },
  { to: "/advisor", label: "nav.advisor", tab: "nav.tab.advisor", icon: "advisor", end: false, core: true },
  { to: "/chat", label: "nav.chat", icon: "spark", end: false, core: false },
  { to: "/plan", label: "nav.plan", icon: "plan", end: false, core: false },
  { to: "/goals", label: "nav.goals", icon: "target", end: false, core: false },
  { to: "/categories", label: "nav.categories", icon: "tag", end: false, core: false },
  { to: "/subs", label: "nav.subs", icon: "repeat", end: false, core: false },
  { to: "/events", label: "nav.events", icon: "folder", end: false, core: false },
];

const LOCALES: Locale[] = ["uk", "en"];

// Segmented UA/EN switch. Two languages → a plain segmented control reads clearer than a
// toggle whose label would have to name the OTHER language.
function LangSwitch() {
  const { locale, setLocale } = useLocale();
  return (
    <div className="lang-seg" role="group" aria-label="Language">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          className={l === locale ? "on" : ""}
          aria-pressed={l === locale}
          onClick={() => setLocale(l)}
        >
          {l === "uk" ? "UA" : "EN"}
        </button>
      ))}
    </div>
  );
}

function useTheme() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-theme") === "dark",
  );
  function toggle() {
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    // Same rewrite `public/theme.js` does before first paint — otherwise the browser/PWA chrome
    // keeps the previous theme's colour until the next reload.
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", next === "dark" ? "#0b0f14" : "#f3f5f8");
    try {
      localStorage.setItem("mt-theme", next);
    } catch {
      /* ignore */
    }
    setDark(!dark);
  }
  return { dark, toggle };
}

// Топбар-пошук: відкриває командну панель (Ctrl-K). Раніше тут був окремий інпут, що вів
// на /tx?q= — панель уміє те саме й більше, тож два пошуки поруч були зайвим вибором.
// Кнопка лишається головним способом ЗНАЙТИ шорткат: без неї про ⌘K ніхто б не дізнався.
function TopSearch() {
  const t = useT();
  return (
    <button type="button" className="top-search" onClick={openCommandPalette}>
      <span className="ico"><Icon name="search" size={16} /></span>
      <span className="ts-ph">{t("layout.search")}</span>
      <kbd className="ts-kbd">⌘K</kbd>
    </button>
  );
}

// Дзвіночок → /notifications. Бейдж — РЕАЛЬНИЙ лічильник непрочитаних (раніше тут висіла
// статична червона крапка, яка світилась завжди й нічого не означала).
function NotifBell() {
  const t = useT();
  // Стрічку наповнює добовий крон, тож рідкого опитування досить — без нього бейдж
  // застигав би до перезавантаження сторінки (RTK кешує, а інвалідації ззовні нема).
  const { data } = useGetNotificationsQuery({ limit: 1 }, { pollingInterval: 600_000 });
  const unread = data?.unread ?? 0;
  return (
    <Link
      to="/notifications"
      className="icon-btn"
      aria-label={unread ? t("layout.notificationsUnread", { count: unread }) : t("layout.notifications")}
    >
      <Icon name="bell" />
      {unread > 0 && <span className="count-badge">{unread > 9 ? "9+" : unread}</span>}
    </Link>
  );
}

/**
 * Перемикач календарний ⇄ ковзний період.
 *
 * Живе в топбарі, бо `app_state.period_mode` — ГЛОБАЛЬНИЙ: він міняє межі періоду і на Головній,
 * і в Статистиці, і в аналітиці. Керування ним лише на одній сторінці означало, що з решти
 * екранів цифри мовчки міняються від дії, якої тут не видно (скарга 2026-08-01).
 */
function PeriodModeToggle() {
  const t = useT();
  const { data } = useGetPeriodModeQuery();
  const [setMode] = useSetPeriodModeMutation();
  const mode = data?.mode ?? "calendar";
  return (
    <button
      className="pill-toggle topbar-period"
      title={t("stats.modeTip")}
      onClick={() => setMode(mode === "calendar" ? "rolling" : "calendar")}
    >
      <Icon name={mode === "calendar" ? "calendar" : "repeat"} size={14} />
      <span className="tp-label">{mode === "calendar" ? t("stats.mode.calendar") : t("stats.mode.rolling")}</span>
    </button>
  );
}

// Demo banner (P4.4). Shown on EVERY screen of a demo sandbox, non-dismissable: it must be
// obvious the numbers are fictional, that the sandbox resets, and that AI is limited.
function DemoBanner({ expiresAt }: { expiresAt?: number | null }) {
  const t = useT();
  const [logout] = useLogoutMutation();
  const hours = expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now() / 1000) / 3600)) : null;
  async function exit() {
    await logout().unwrap().catch(() => {});
    window.location.href = "/"; // full reload → unauthenticated → landing/login
  }
  return (
    <div className="demo-banner" role="status">
      <Icon name="info" size={15} />
      <span className="db-badge">{t("demo.badge")}</span>
      <span className="db-text">
        {t("demo.fictional")}
        {hours != null && <> · {t("demo.resets", { h: hours })}</>}
        {" · "}{t("demo.aiLimited")}
      </span>
      <button type="button" className="db-exit" onClick={exit}>{t("demo.exit")}</button>
    </div>
  );
}

export function Layout() {
  const { dark, toggle } = useTheme();
  const [moreOpen, setMoreOpen] = useState(false);
  const t = useT();
  const { data: me } = useGetMeQuery();
  const isDemo = me?.demo === true;
  const accountName = (me?.user?.name ?? "").trim().split(/\s+/)[0] || t("layout.account");

  return (
    <div className={`shell${isDemo ? " has-demo-banner" : ""}`}>
      <Toaster />
      <CommandPalette />
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">₴</span>
          <span className="name">money<span className="dot">·</span>track</span>
        </div>

        <div className="side-group">{t("nav.menu")}</div>
        <nav className="side-nav">
          {items.map((it) => (
            <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => (isActive ? "active" : "")}>
              <span className="ico"><Icon name={it.icon} /></span>
              {t(it.label)}
            </NavLink>
          ))}
          <NavLink to="/add" className={({ isActive }) => `add ${isActive ? "active" : ""}`}>
            <span className="ico"><Icon name="add" /></span>
            {t("nav.add")}
          </NavLink>
        </nav>

        <div className="side-foot side-nav">
          <NavLink to="/setup" className={({ isActive }) => (isActive ? "active" : "")}>
            <span className="ico"><Icon name="settings" /></span>
            {t("nav.settings")}
          </NavLink>
          <LangSwitch />
          <div className="theme-toggle" onClick={toggle} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggle(); }}>
            <span className="row">
              <span className="ico"><Icon name={dark ? "sun" : "moon"} /></span>
              {dark ? t("layout.themeLight") : t("layout.themeDark")}
            </span>
            <span className={`switch ${dark ? "on" : ""}`} />
          </div>
        </div>
      </aside>

      <main className="main">
        {isDemo && <DemoBanner expiresAt={me?.demo_expires_at} />}
        <header className="topbar">
          <Link to="/" className="topbar-brand">
            <span className="mark">₴</span>
            <span className="name">money<span className="dot" style={{ color: "var(--accent)" }}>·</span>track</span>
          </Link>
          <div className="topbar-right">
            <TopSearch />
            <PeriodModeToggle />
            {/* §A6: поки фонова генерація йде, вона видима з БУДЬ-ЯКОЇ сторінки — інакше
                «пішов і забув» нічим не відрізняється від «нічого не запустилось». */}
            <AiJobChip />
            <NotifBell />
            <Link to="/setup" className="avatar-chip">
              {/* Name and initial come from the signed-in account — they were hardcoded to the
                  owner, so every other user (and every demo visitor) saw "Віталій". */}
              <span className="avatar">{isDemo ? "D" : (accountName[0] ?? "?").toUpperCase()}</span>
              <span className="who2">
                <b>{isDemo ? t("demo.badge") : accountName}</b>
                <small>{isDemo ? t("demo.aiLimited") : t("layout.personal")}</small>
              </span>
            </Link>
          </div>
        </header>

        <div className="content">
          <Outlet />
        </div>
      </main>

      {/* Bottom bar labels come from `nav.tab.*`, not from the sidebar's `label`: six tabs of
          "Транзакції"/"Transactions" at 10.5px are wider than an iPhone, and a flex item's
          default `min-width: auto` let that text push the fixed bar past the viewport — which
          is what made every page scroll sideways. Short label + `.lbl` truncation, so a longer
          translation degrades to an ellipsis instead of breaking the layout. */}
      <nav className="nav bottom">
        {items.filter((it) => it.core).map((it) => (
          <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => (isActive ? "active" : "")}>
            <span className="ico"><Icon name={it.icon} size={20} /></span>
            <span className="lbl">{t(it.tab ?? it.label)}</span>
          </NavLink>
        ))}
        <NavLink to="/add" className={({ isActive }) => (isActive ? "active" : "")}>
          <span className="ico"><Icon name="add" size={20} /></span>
          <span className="lbl">{t("nav.add")}</span>
        </NavLink>
        <button type="button" className={`more-btn ${moreOpen ? "active" : ""}`} onClick={() => setMoreOpen(true)}>
          <span className="ico"><Icon name="overview" size={20} /></span>
          <span className="lbl">{t("nav.more")}</span>
        </button>
      </nav>

      {moreOpen && (
        <div className="more-overlay" onClick={() => setMoreOpen(false)}>
          <div className="more-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="more-grip" />
            <div className="more-grid">
              {items.filter((it) => !it.core).map((it) => (
                <NavLink key={it.to} to={it.to} end={it.end} onClick={() => setMoreOpen(false)}
                  className={({ isActive }) => `more-item ${isActive ? "active" : ""}`}>
                  <span className="ico"><Icon name={it.icon} size={22} /></span>
                  {t(it.label)}
                </NavLink>
              ))}
              <NavLink to="/setup" onClick={() => setMoreOpen(false)}
                className={({ isActive }) => `more-item ${isActive ? "active" : ""}`}>
                <span className="ico"><Icon name="settings" size={22} /></span>
                {t("nav.settings")}
              </NavLink>
            </div>
            <button className="more-theme" onClick={toggle}>
              <span className="ico"><Icon name={dark ? "sun" : "moon"} size={20} /></span>
              {dark ? t("layout.themeLight") : t("layout.themeDark")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
