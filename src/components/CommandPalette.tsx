// Глобальна командна панель (Ctrl-K / ⌘K): сторінки, дії, мерчанти, категорії, операції.
// Мета — дістатись будь-куди без навігації мишею. Сторінки й дії статичні (фільтруються
// на клієнті), дані з бази — через `/search` (дебаунс, бо панель смикає його на кожен ввід).
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLazySearchQuery } from "../store/api.ts";
import type { SearchResults } from "../store/api.ts";
import { Icon } from "./Icon.tsx";
import { formatMinor } from "../lib/format.ts";

interface Item {
  key: string;
  group: string;
  icon: string;
  label: string;
  hint?: string;
  to: string;
}

// Статична частина: усе, куди можна піти або що можна зробити одним кроком.
const STATIC: Item[] = [
  { key: "p-home", group: "Сторінки", icon: "overview", label: "Огляд", to: "/" },
  { key: "p-tx", group: "Сторінки", icon: "tx", label: "Транзакції", to: "/tx" },
  { key: "p-stats", group: "Сторінки", icon: "stats", label: "Статистика", to: "/stats" },
  { key: "p-advisor", group: "Сторінки", icon: "advisor", label: "Порадник", to: "/advisor" },
  { key: "p-chat", group: "Сторінки", icon: "spark", label: "Чат з AI", to: "/chat" },
  { key: "p-reports", group: "Сторінки", icon: "report", label: "Репорти", to: "/reports" },
  { key: "p-plan", group: "Сторінки", icon: "plan", label: "Бюджети", to: "/plan" },
  { key: "p-goals", group: "Сторінки", icon: "target", label: "Цілі", to: "/goals" },
  { key: "p-subs", group: "Сторінки", icon: "repeat", label: "Підписки", to: "/subs" },
  { key: "p-cats", group: "Сторінки", icon: "tag", label: "Категорії", to: "/categories" },
  { key: "p-events", group: "Сторінки", icon: "folder", label: "Групи", to: "/events" },
  { key: "p-accounts", group: "Сторінки", icon: "accounts", label: "Рахунки", to: "/accounts" },
  { key: "p-notif", group: "Сторінки", icon: "bell", label: "Сповіщення", to: "/notifications" },
  { key: "p-setup", group: "Сторінки", icon: "settings", label: "Налаштування", to: "/setup" },
  { key: "a-add", group: "Дії", icon: "add", label: "Додати операцію", to: "/add" },
  { key: "a-compare", group: "Дії", icon: "swap", label: "Порівняти місяці", to: "/stats?tab=compare" },
  { key: "a-state", group: "Дії", icon: "advisor", label: "Стан фінансів", to: "/advisor?tab=state" },
  { key: "a-csv", group: "Дії", icon: "export", label: "Експорт CSV", to: "/tx" },
];

/** Відкрити панель ззовні (кнопка-пошук у топбарі). Подія — щоб не тягнути глобальний стейт. */
export const CMDK_EVENT = "mt:cmdk";
export const openCommandPalette = () => document.dispatchEvent(new CustomEvent(CMDK_EVENT));

const norm = (s: string) => s.toLowerCase().trim();
const dtf = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short" });

function resultsToItems(r: SearchResults | undefined): Item[] {
  if (!r) return [];
  return [
    ...r.merchants.map((m) => ({
      key: `m-${m.name}`, group: "Мерчанти", icon: "tx", label: m.name,
      hint: `${m.n} оп · ${formatMinor(m.spent, { decimals: false })} ₴`,
      to: `/merchant/${encodeURIComponent(m.name)}`,
    })),
    ...r.categories.map((c) => ({
      key: `c-${c.id}`, group: "Категорії", icon: "tag", label: c.name,
      hint: c.parent_name ?? undefined,
      to: `/tx?cats=${c.id}`,
    })),
    ...r.transactions.map((t) => ({
      key: `t-${t.id}`, group: "Операції", icon: "tx",
      label: t.merchant ?? "без назви",
      hint: `${dtf.format(t.time * 1000)} · ${formatMinor(Math.abs(t.amount), { decimals: false })} ₴${t.category_name ? ` · ${t.category_name}` : ""}`,
      to: `/tx/${t.id}`,
    })),
  ];
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [search, { data }] = useLazySearchQuery();

  // Ctrl-K / ⌘K глобально + подія `mt:cmdk` (нею панель відкриває кнопка в топбарі —
  // так пошук у застосунку рівно один, без дубля «інпут у шапці vs палітра»).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    document.addEventListener(CMDK_EVENT, onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener(CMDK_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) { setQ(""); setActive(0); requestAnimationFrame(() => inputRef.current?.focus()); }
  }, [open]);

  // Дебаунс: панель смикала б `/search` на кожну літеру. 180 мс — межа, за якою
  // пошук ще здається миттєвим, але зайвих запитів уже нема.
  useEffect(() => {
    if (!open || q.trim().length < 2) return;
    const id = setTimeout(() => { void search(q.trim()); }, 180);
    return () => clearTimeout(id);
  }, [q, open, search]);

  const items = useMemo(() => {
    const nq = norm(q);
    const staticHits = nq ? STATIC.filter((i) => norm(i.label).includes(nq)) : STATIC.slice(0, 8);
    // Серверні результати додаємо лише коли запит достатньо довгий — інакше показуємо
    // «куди піти», а не порожнечу.
    return nq.length >= 2 ? [...staticHits, ...resultsToItems(data)] : staticHits;
  }, [q, data]);

  useEffect(() => { setActive(0); }, [items.length]);

  const go = (item: Item) => { setOpen(false); navigate(item.to); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && items[active]) { e.preventDefault(); go(items[active]); }
  };

  // Тримаємо активний рядок у полі зору при навігації клавіатурою.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  let lastGroup = "";
  return (
    <div className="cmdk-overlay" onClick={() => setOpen(false)} role="presentation">
      <div className="cmdk" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Пошук">
        <div className="cmdk-input">
          <Icon name="search" size={17} />
          <input
            ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Сторінка, мерчант, категорія, операція…" aria-label="Пошук"
          />
          <kbd>esc</kbd>
        </div>

        <div className="cmdk-list" ref={listRef} role="listbox">
          {items.length === 0 && (
            <div className="cmdk-empty">
              {q.trim().length < 2 ? "Введи щонайменше 2 символи." : "Нічого не знайшлось."}
            </div>
          )}
          {items.map((item, i) => {
            const head = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.key}>
                {head && <div className="cmdk-group">{head}</div>}
                <button
                  type="button" data-idx={i} role="option" aria-selected={i === active}
                  className={`cmdk-row ${i === active ? "active" : ""}`}
                  onMouseEnter={() => setActive(i)} onClick={() => go(item)}
                >
                  <span className="cmdk-ico"><Icon name={item.icon} size={15} /></span>
                  <span className="cmdk-label">{item.label}</span>
                  {item.hint && <span className="cmdk-hint">{item.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
