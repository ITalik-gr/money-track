// Глобальна командна панель (Ctrl-K / ⌘K): сторінки, дії, мерчанти, категорії, операції.
// Мета — дістатись будь-куди без навігації мишею. Сторінки й дії статичні (фільтруються
// на клієнті), дані з бази — через `/search` (дебаунс, бо панель смикає його на кожен ввід).
import { useEffect, useMemo, useRef, useState } from "react";
import { dateFmt } from "../../i18n/locale.ts";
import { useT, type TranslationKey } from "../../i18n/index.ts";
import { useNavigate } from "react-router-dom";
import { useLazySearchQuery } from "../../store/api.ts";
import type { SearchResults } from "../../store/api.ts";
import { Icon } from "../ui/Icon.tsx";
import { formatMinor } from "../../lib/format.ts";
import { baseSign } from "../../lib/currency.ts";

interface Item {
  key: string;
  group: string;
  icon: string;
  label: string;
  hint?: string;
  to: string;
}

interface StaticItem {
  key: string;
  groupKey: "cmdk.groupPages" | "cmdk.groupActions";
  icon: string;
  labelKey: TranslationKey;
  to: string;
}

// Статична частина: усе, куди можна піти або що можна зробити одним кроком.
const STATIC: StaticItem[] = [
  { key: "p-home", groupKey: "cmdk.groupPages", icon: "overview", labelKey: "nav.overview", to: "/" },
  { key: "p-tx", groupKey: "cmdk.groupPages", icon: "tx", labelKey: "nav.tx", to: "/tx" },
  { key: "p-stats", groupKey: "cmdk.groupPages", icon: "stats", labelKey: "nav.stats", to: "/stats" },
  { key: "p-advisor", groupKey: "cmdk.groupPages", icon: "advisor", labelKey: "nav.advisor", to: "/advisor" },
  { key: "p-chat", groupKey: "cmdk.groupPages", icon: "spark", labelKey: "nav.chat", to: "/chat" },
  { key: "p-reports", groupKey: "cmdk.groupPages", icon: "report", labelKey: "nav.reports", to: "/reports" },
  { key: "p-plan", groupKey: "cmdk.groupPages", icon: "plan", labelKey: "nav.plan", to: "/plan" },
  { key: "p-goals", groupKey: "cmdk.groupPages", icon: "target", labelKey: "nav.goals", to: "/goals" },
  { key: "p-subs", groupKey: "cmdk.groupPages", icon: "repeat", labelKey: "nav.subs", to: "/subs" },
  { key: "p-cats", groupKey: "cmdk.groupPages", icon: "tag", labelKey: "nav.categories", to: "/categories" },
  { key: "p-events", groupKey: "cmdk.groupPages", icon: "folder", labelKey: "nav.events", to: "/events" },
  { key: "p-accounts", groupKey: "cmdk.groupPages", icon: "accounts", labelKey: "nav.accounts", to: "/accounts" },
  { key: "p-notif", groupKey: "cmdk.groupPages", icon: "bell", labelKey: "notif.title", to: "/notifications" },
  { key: "p-setup", groupKey: "cmdk.groupPages", icon: "settings", labelKey: "nav.settings", to: "/setup" },
  { key: "a-add", groupKey: "cmdk.groupActions", icon: "add", labelKey: "cmdk.actionAdd", to: "/add" },
  { key: "a-compare", groupKey: "cmdk.groupActions", icon: "swap", labelKey: "cmdk.actionCompare", to: "/stats?tab=compare" },
  { key: "a-state", groupKey: "cmdk.groupActions", icon: "advisor", labelKey: "adv.tabState", to: "/advisor?tab=state" },
  { key: "a-csv", groupKey: "cmdk.groupActions", icon: "export", labelKey: "cmdk.actionExportCsv", to: "/tx" },
];

/** Відкрити панель ззовні (кнопка-пошук у топбарі). Подія — щоб не тягнути глобальний стейт. */
export const CMDK_EVENT = "mt:cmdk";
export const openCommandPalette = () => document.dispatchEvent(new CustomEvent(CMDK_EVENT));

const norm = (s: string) => s.toLowerCase().trim();
const dtf = dateFmt({ day: "numeric", month: "short" });

function resultsToItems(r: SearchResults | undefined, t: (key: TranslationKey, params?: Record<string, string | number>) => string): Item[] {
  if (!r) return [];
  return [
    ...r.merchants.map((m) => ({
      key: `m-${m.name}`, group: t("cmdk.groupMerchants"), icon: "tx", label: m.name,
      hint: t("cmdk.merchantHint", { n: m.n, amount: formatMinor(m.spent, { decimals: false }) }),
      to: `/merchant/${encodeURIComponent(m.name)}`,
    })),
    ...r.categories.map((c) => ({
      key: `c-${c.id}`, group: t("cmdk.groupCategories"), icon: "tag", label: c.name,
      hint: c.parent_name ?? undefined,
      to: `/tx?cats=${c.id}`,
    })),
    ...r.transactions.map((tx) => ({
      key: `t-${tx.id}`, group: t("cmdk.groupTransactions"), icon: "tx",
      label: tx.merchant ?? t("cmdk.txNoName"),
      hint: `${dtf.format(tx.time * 1000)} · ${formatMinor(Math.abs(tx.amount), { decimals: false })} ${baseSign()}${tx.category_name ? ` · ${tx.category_name}` : ""}`,
      to: `/tx/${tx.id}`,
    })),
  ];
}

export function CommandPalette() {
  const t = useT();
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
    const staticAll: Item[] = STATIC.map((s) => ({ key: s.key, group: t(s.groupKey), icon: s.icon, label: t(s.labelKey), to: s.to }));
    const staticHits = nq ? staticAll.filter((i) => norm(i.label).includes(nq)) : staticAll.slice(0, 8);
    // Серверні результати додаємо лише коли запит достатньо довгий — інакше показуємо
    // «куди піти», а не порожнечу.
    return nq.length >= 2 ? [...staticHits, ...resultsToItems(data, t)] : staticHits;
  }, [q, data, t]);

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
      <div className="cmdk" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t("cmdk.searchAria")}>
        <div className="cmdk-input">
          <Icon name="search" size={17} />
          <input
            ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
            placeholder={t("cmdk.searchPlaceholder")} aria-label={t("cmdk.searchAria")}
          />
          <kbd>esc</kbd>
        </div>

        <div className="cmdk-list" ref={listRef} role="listbox">
          {items.length === 0 && (
            <div className="cmdk-empty">
              {q.trim().length < 2 ? t("cmdk.needMoreChars") : t("cmdk.noResults")}
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
