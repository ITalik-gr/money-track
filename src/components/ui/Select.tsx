import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CategoryIcon } from "./CategoryIcon.tsx";
import { useT } from "../../i18n/index.ts";

export interface SelectOption {
  value: string | number;
  label: string;
  color?: string | null;
  icon?: string | null;     // CategoryIcon slug
  hint?: string | null;     // secondary text on the right
  indent?: boolean;         // subcategory — indented
}

interface Props {
  value: string | number | null;
  options: SelectOption[];
  onChange: (value: string | number | null) => void;
  placeholder?: string;
  searchable?: boolean;
  clearable?: boolean;      // adds a "— none" option that yields null
  clearLabel?: string;
  disabled?: boolean;
  className?: string;
}

// Проєктний красивий селект (заміна нативному <select>): кольорова крапка/іконка,
// пошук, клавіатура, click-outside. Юзаємо всюди — категорії, події, підписки, валюта.
export function Select({
  value, options, onChange, placeholder,
  searchable, clearable, clearLabel, disabled, className,
}: Props) {
  const t = useT();
  const resolvedPlaceholder = placeholder ?? t("select.defaultPlaceholder");
  const resolvedClearLabel = clearLabel ?? t("select.defaultClearLabel");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [drop, setDrop] = useState<"down" | "up">("down");
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => String(o.value) === String(value)) ?? null;

  const filtered = query.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Відкриваємо вгору, якщо знизу мало місця.
  useLayoutEffect(() => {
    if (open && rootRef.current) {
      const r = rootRef.current.getBoundingClientRect();
      setDrop(window.innerHeight - r.bottom < 280 && r.top > 280 ? "up" : "down");
      setActive(Math.max(0, filtered.findIndex((o) => String(o.value) === String(value))));
      if (searchable) setTimeout(() => searchRef.current?.focus(), 0);
    } else {
      setQuery("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function choose(v: string | number | null) {
    onChange(v);
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (disabled) return;
    if (!open && (e.key === "Enter" || e.key === "ArrowDown" || e.key === " ")) { e.preventDefault(); setOpen(true); return; }
    if (!open) return;
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === "Enter") { e.preventDefault(); const o = filtered[active]; if (o) choose(o.value); }
  }

  useEffect(() => {
    if (open && listRef.current) {
      const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${active}"]`);
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [active, open]);

  return (
    <div className={`sel ${open ? "open" : ""} ${disabled ? "disabled" : ""} ${className ?? ""}`} ref={rootRef}>
      <button type="button" className="sel-trigger" disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)} onKeyDown={onKey} aria-haspopup="listbox" aria-expanded={open}>
        <span className="sel-value">
          {selected ? <OptionInner o={selected} /> : <span className="sel-placeholder">{resolvedPlaceholder}</span>}
        </span>
        <svg className="sel-caret" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>

      {open && (
        <div className={`sel-pop ${drop}`} role="listbox">
          {searchable && (
            <div className="sel-search">
              <input ref={searchRef} value={query} placeholder={t("select.searchPlaceholder")}
                onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKey} />
            </div>
          )}
          <div className="sel-list" ref={listRef}>
            {clearable && !query && (
              <div className={`sel-opt ${value == null ? "sel-selected" : ""}`} data-idx={-1}
                onMouseDown={(e) => { e.preventDefault(); choose(null); }}>
                <span className="sel-clear">{resolvedClearLabel}</span>
              </div>
            )}
            {filtered.map((o, i) => (
              <div key={String(o.value)} data-idx={i}
                className={`sel-opt ${o.indent ? "indent" : ""} ${i === active ? "active" : ""} ${String(o.value) === String(value) ? "sel-selected" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(o.value); }}>
                <OptionInner o={o} />
                {o.hint && <span className="sel-hint">{o.hint}</span>}
              </div>
            ))}
            {!filtered.length && <div className="sel-empty">{t("select.noResults")}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function OptionInner({ o }: { o: SelectOption }) {
  return (
    <span className="sel-opt-inner">
      {o.icon
        ? <span className="sel-ico" style={{ background: o.color ?? "var(--muted)" }}><CategoryIcon slug={o.icon} size={15} /></span>
        : o.color
          ? <span className="sel-dot" style={{ background: o.color }} />
          : null}
      <span className="sel-label">{o.label}</span>
    </span>
  );
}
