import { useState } from "react";
import { NavLink, Outlet, Link } from "react-router-dom";
import { Icon } from "./Icon.tsx";
import { Toaster } from "./Toaster.tsx";
import { CommandPalette, openCommandPalette } from "./CommandPalette.tsx";
import { useGetNotificationsQuery } from "../store/api.ts";

// Пункти навігації. desktop=сайдбар (усі), mobile=нижній таб-бар (тільки core).
const items = [
  { to: "/", label: "Огляд", icon: "overview", end: true, core: true },
  { to: "/tx", label: "Транзакції", icon: "tx", end: false, core: true },
  { to: "/accounts", label: "Рахунки", icon: "accounts", end: false, core: false },
  { to: "/stats", label: "Статистика", icon: "stats", end: false, core: true },
  { to: "/reports", label: "Репорти", icon: "report", end: false, core: false },
  { to: "/advisor", label: "Порадник", icon: "advisor", end: false, core: true },
  { to: "/chat", label: "Чат з AI", icon: "spark", end: false, core: false },
  { to: "/plan", label: "Бюджети", icon: "plan", end: false, core: false },
  { to: "/goals", label: "Цілі", icon: "target", end: false, core: false },
  { to: "/categories", label: "Категорії", icon: "tag", end: false, core: false },
  { to: "/subs", label: "Підписки", icon: "repeat", end: false, core: false },
  { to: "/events", label: "Групи", icon: "folder", end: false, core: false },
];

function useTheme() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-theme") === "dark",
  );
  function toggle() {
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
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
  return (
    <button type="button" className="top-search" onClick={openCommandPalette}>
      <span className="ico"><Icon name="search" size={16} /></span>
      <span className="ts-ph">Пошук…</span>
      <kbd className="ts-kbd">⌘K</kbd>
    </button>
  );
}

// Дзвіночок → /notifications. Бейдж — РЕАЛЬНИЙ лічильник непрочитаних (раніше тут висіла
// статична червона крапка, яка світилась завжди й нічого не означала).
function NotifBell() {
  // Стрічку наповнює добовий крон, тож рідкого опитування досить — без нього бейдж
  // застигав би до перезавантаження сторінки (RTK кешує, а інвалідації ззовні нема).
  const { data } = useGetNotificationsQuery({ limit: 1 }, { pollingInterval: 600_000 });
  const unread = data?.unread ?? 0;
  return (
    <Link
      to="/notifications"
      className="icon-btn"
      aria-label={unread ? `Сповіщення, непрочитаних: ${unread}` : "Сповіщення"}
    >
      <Icon name="bell" />
      {unread > 0 && <span className="count-badge">{unread > 9 ? "9+" : unread}</span>}
    </Link>
  );
}

export function Layout() {
  const { dark, toggle } = useTheme();
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <div className="shell">
      <Toaster />
      <CommandPalette />
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">₴</span>
          <span className="name">money<span className="dot">·</span>track</span>
        </div>

        <div className="side-group">Меню</div>
        <nav className="side-nav">
          {items.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? "active" : "")}>
              <span className="ico"><Icon name={t.icon} /></span>
              {t.label}
            </NavLink>
          ))}
          <NavLink to="/add" className={({ isActive }) => `add ${isActive ? "active" : ""}`}>
            <span className="ico"><Icon name="add" /></span>
            Додати
          </NavLink>
        </nav>

        <div className="side-foot side-nav">
          <NavLink to="/setup" className={({ isActive }) => (isActive ? "active" : "")}>
            <span className="ico"><Icon name="settings" /></span>
            Налаштування
          </NavLink>
          <div className="theme-toggle" onClick={toggle} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggle(); }}>
            <span className="row">
              <span className="ico"><Icon name={dark ? "sun" : "moon"} /></span>
              {dark ? "Світла тема" : "Темна тема"}
            </span>
            <span className={`switch ${dark ? "on" : ""}`} />
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <Link to="/" className="topbar-brand">
            <span className="mark">₴</span>
            <span className="name">money<span className="dot" style={{ color: "var(--accent)" }}>·</span>track</span>
          </Link>
          <div className="topbar-right">
            <TopSearch />
            <NotifBell />
            <Link to="/setup" className="avatar-chip">
              <span className="avatar">В</span>
              <span className="who2">
                <b>Віталій</b>
                <small>особистий</small>
              </span>
            </Link>
          </div>
        </header>

        <div className="content">
          <Outlet />
        </div>
      </main>

      <nav className="nav bottom">
        {items.filter((t) => t.core).map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? "active" : "")}>
            <span className="ico"><Icon name={t.icon} size={20} /></span>
            {t.label}
          </NavLink>
        ))}
        <NavLink to="/add" className={({ isActive }) => (isActive ? "active" : "")}>
          <span className="ico"><Icon name="add" size={20} /></span>
          Додати
        </NavLink>
        <button type="button" className={`more-btn ${moreOpen ? "active" : ""}`} onClick={() => setMoreOpen(true)}>
          <span className="ico"><Icon name="overview" size={20} /></span>
          Ще
        </button>
      </nav>

      {moreOpen && (
        <div className="more-overlay" onClick={() => setMoreOpen(false)}>
          <div className="more-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="more-grip" />
            <div className="more-grid">
              {items.filter((t) => !t.core).map((t) => (
                <NavLink key={t.to} to={t.to} end={t.end} onClick={() => setMoreOpen(false)}
                  className={({ isActive }) => `more-item ${isActive ? "active" : ""}`}>
                  <span className="ico"><Icon name={t.icon} size={22} /></span>
                  {t.label}
                </NavLink>
              ))}
              <NavLink to="/setup" onClick={() => setMoreOpen(false)}
                className={({ isActive }) => `more-item ${isActive ? "active" : ""}`}>
                <span className="ico"><Icon name="settings" size={22} /></span>
                Налаштування
              </NavLink>
            </div>
            <button className="more-theme" onClick={toggle}>
              <span className="ico"><Icon name={dark ? "sun" : "moon"} size={20} /></span>
              {dark ? "Світла тема" : "Темна тема"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
