import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { TransactionList } from "../components/TransactionList.tsx";
import { Icon } from "../components/Icon.tsx";
import { CategoryIcon } from "../components/CategoryIcon.tsx";
import { Select } from "../components/Select.tsx";
import { GroupModal } from "../components/GroupModal.tsx";
import {
  useBulkEditTransactionsMutation,
  useGetAccountsQuery,
  useGetCategoriesQuery,
  useGetEventsQuery,
  useGetTransactionsQuery,
} from "../store/api.ts";
import type { Category } from "../../shared/types.ts";

// yyyy-mm-dd (для <input type=date>) ↔ unix-секунди.
function dateToUnix(s: string, endOfDay = false): number | undefined {
  if (!s) return undefined;
  const d = new Date(s + (endOfDay ? "T23:59:59" : "T00:00:00"));
  return Number.isNaN(d.getTime()) ? undefined : Math.floor(d.getTime() / 1000);
}

export function Transactions() {
  // Фільтри живуть в URL, щоб переживати перехід у транзакцію й Back.
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const cat = params.get("cat");            // точна (під)категорія
  const catp = params.get("catp");          // батьк-категорія (з підкатегоріями)
  const type = params.get("type") ?? "";    // expense | income
  const acc = params.get("acc") ?? "";      // рахунок (account_id)
  const dfrom = params.get("dfrom") ?? "";  // yyyy-mm-dd
  const dto = params.get("dto") ?? "";
  const amin = params.get("amin") ?? "";    // сума ₴ (по модулю)
  const amax = params.get("amax") ?? "";
  const category = cat ? Number(cat) : undefined;
  const catparent = catp ? Number(catp) : undefined;

  function patch(next: Record<string, string | null>) {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k); }
      return p;
    }, { replace: true });
  }

  const { data: cats } = useGetCategoriesQuery();
  const { data: groups = [] } = useGetEventsQuery();
  const { data: accounts = [] } = useGetAccountsQuery();

  // §R2-TX2/§R6: зберігаємо і позицію скролу, І скільки підвантажено ("показати більше"),
  // щоб при поверненні з транзакції відновити той самий вигляд, а не кидати на верх.
  // Ключі прив'язані до набору фільтрів (кожен фільтр — власна позиція/ліміт).
  const stateKey = params.toString();
  const scrollKey = `tx-scroll:${stateKey}`;
  const limitKey = `tx-limit:${stateKey}`;

  const [limit, setLimit] = useState(() => Number(sessionStorage.getItem(limitKey)) || 100);
  const { data: rows = [], isFetching } = useGetTransactionsQuery({
    limit, q: q || undefined, category, catparent, type: type || undefined,
    account: acc || undefined, from: dateToUnix(dfrom), to: dateToUnix(dto, true),
    amin: amin ? Number(amin) : undefined, amax: amax ? Number(amax) : undefined,
  });
  const hasMore = rows.length >= limit;
  const [bulkEdit, { isLoading: bulkSaving }] = useBulkEditTransactionsMutation();

  // Персист ліміту, щоб пережити навігацію в транзакцію й назад.
  useEffect(() => { sessionStorage.setItem(limitKey, String(limit)); }, [limit, limitKey]);

  const restoredRef = useRef(false);
  const prevKeyRef = useRef(stateKey);
  useEffect(() => {
    const onScroll = () => sessionStorage.setItem(scrollKey, String(window.scrollY));
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [scrollKey]);
  useEffect(() => {
    // Скидаємо ліміт і позицію ЛИШЕ коли реально змінилися фільтри (не на першому монтуванні
    // й не при поверненні з транзакції — там stateKey той самий, тож відновлюємо збережене).
    if (prevKeyRef.current !== stateKey) {
      prevKeyRef.current = stateKey;
      restoredRef.current = false;
      setLimit(Number(sessionStorage.getItem(limitKey)) || 100);
    }
  }, [stateKey, limitKey]);
  useEffect(() => {
    if (restoredRef.current || isFetching || rows.length === 0) return;
    const saved = sessionStorage.getItem(scrollKey);
    if (saved != null) {
      const y = Number(saved);
      // Чекаємо кадр, щоб список встиг відрендеритись на повну висоту.
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
    restoredRef.current = true;
  }, [isFetching, rows.length, scrollKey]);

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  function toggle(id: string) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function exitSelect() { setSelectMode(false); setSelected(new Set()); }
  const ids = useMemo(() => [...selected], [selected]);

  async function assignGroup(eventId: number | null) { if (!ids.length) return; await bulkEdit({ ids, event_id: eventId }).unwrap(); exitSelect(); }
  async function assignCategory(categoryId: number | null) { if (!ids.length) return; await bulkEdit({ ids, category_id: categoryId }).unwrap(); exitSelect(); }
  async function markTransfer() { if (!ids.length) return; await bulkEdit({ ids, is_transfer: true }).unwrap(); exitSelect(); }

  const tops = (cats ?? []).filter((c) => c.parent_id == null && !c.is_income);
  const childrenOf = (id: number) => (cats ?? []).filter((c) => c.parent_id === id);
  const catOptions = (cats ?? []).map((c) => ({ value: c.id, label: c.name, color: c.color, icon: c.icon, indent: !!c.parent_id }));
  const groupOptions = groups.map((g) => ({ value: g.id, label: g.name, color: g.color, hint: `${g.tx_count} оп.` }));
  const accOptions = accounts.map((a) => ({ value: a.id, label: a.title ?? a.id }));
  const anyFilter = !!(q || cat || catp || type || acc || dfrom || dto || amin || amax);
  function clearAll() { patch({ q: null, cat: null, catp: null, type: null, acc: null, dfrom: null, dto: null, amin: null, amax: null }); }

  function toggleExpand(id: number) { setExpanded((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }
  function pickParent(c: Category) { patch({ catp: String(c.id), cat: null }); }
  function pickChild(c: Category) { patch({ cat: String(c.id), catp: null }); }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">Транзакції</div>
          <div className="sub">Усі операції з пошуком, фільтром і групуванням.</div>
        </div>
        <div className="page-head-actions">
          <button className={`btn select-btn ${selectMode ? "primary" : ""}`} onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}>
            <Icon name={selectMode ? "overview" : "tag"} size={16} />
            {selectMode ? "Готово" : "Вибрати"}
          </button>
        </div>
      </div>

      <div className="tx-layout">
        <aside className="tx-filters">
          {/* §R2-TX1: дубль «Вибрати» у sticky-сайдбарі — лишається видимим при скролі. */}
          <button
            className={`btn select-btn ${selectMode ? "primary" : ""}`}
            style={{ width: "100%", justifyContent: "center", marginBottom: 12 }}
            onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
          >
            <Icon name={selectMode ? "overview" : "tag"} size={16} />
            {selectMode ? "Готово" : "Вибрати"}
          </button>
          <div className="searchbar" style={{ marginBottom: 12 }}>
            <span className="ico"><Icon name="search" size={17} /></span>
            <input placeholder="Пошук…" value={q} onChange={(e) => patch({ q: e.target.value })} />
          </div>

          <div className="seg" style={{ marginBottom: 14 }}>
            {[["", "Усі"], ["expense", "Витрати"], ["income", "Доходи"]].map(([v, l]) => (
              <button key={v} className={`seg-btn ${type === v ? "active" : ""}`} onClick={() => patch({ type: v || null })}>{l}</button>
            ))}
          </div>

          {accOptions.length > 1 && (
            <div style={{ marginBottom: 14 }}>
              <div className="filt-label">Рахунок</div>
              <Select value={acc || null} clearable clearLabel="усі рахунки" placeholder="Усі рахунки"
                options={accOptions} onChange={(v) => patch({ acc: v == null ? null : String(v) })} />
            </div>
          )}

          <div className="filt-label">Сума, ₴</div>
          <div className="filt-range" style={{ marginBottom: 14 }}>
            <input type="number" inputMode="decimal" min="0" placeholder="від" value={amin} onChange={(e) => patch({ amin: e.target.value || null })} />
            <span style={{width: "16px", maxWidth: "16px", overflow: "hidden"}} className="dash">–</span>
            <input type="number" inputMode="decimal" min="0" placeholder="до" value={amax} onChange={(e) => patch({ amax: e.target.value || null })} />
          </div>

          <div className="filt-label">Період</div>
          <div className="filt-range" style={{ marginBottom: 14 }}>
            <input type="date" value={dfrom} max={dto || undefined} onChange={(e) => patch({ dfrom: e.target.value || null })} />
            <span style={{width: "16px", maxWidth: "16px", overflow: "hidden"}} className="dash">–</span>
            <input type="date" value={dto} min={dfrom || undefined} onChange={(e) => patch({ dto: e.target.value || null })} />
          </div>

          <div className="filt-label">Категорії</div>
          <div className="cat-tree">
            <button className={`cat-tree-row ${!cat && !catp ? "on" : ""}`} onClick={() => patch({ cat: null, catp: null })}>
              <span className="ctr-name">Усі категорії</span>
            </button>
            {tops.map((c) => {
              const kids = childrenOf(c.id);
              const open = expanded.has(c.id);
              const active = catp === String(c.id);
              return (
                <div key={c.id}>
                  <div className={`cat-tree-row ${active ? "on" : ""}`}>
                    <button className="ctr-main" onClick={() => pickParent(c)}>
                      <span className="ctr-ico" style={{ background: c.color ?? "var(--muted)" }}><CategoryIcon slug={c.icon} size={13} /></span>
                      <span className="ctr-name">{c.name}</span>
                    </button>
                    {kids.length > 0 && (
                      <button className="ctr-caret" onClick={() => toggleExpand(c.id)} aria-label="Розгорнути">
                        <Icon name="chevron" size={15} />{open ? "" : ""}
                      </button>
                    )}
                  </div>
                  {open && kids.map((ch) => (
                    <button key={ch.id} className={`cat-tree-row sub ${cat === String(ch.id) ? "on" : ""}`} onClick={() => pickChild(ch)}>
                      <span className="ctr-dot" style={{ background: ch.color ?? c.color ?? "var(--muted)" }} />
                      <span className="ctr-name">{ch.name}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>

          {anyFilter && <button className="btn ghost filt-clear" onClick={clearAll}>Скинути фільтри</button>}
        </aside>

        <div className="tx-main">
          {isFetching && <div className="label" style={{ margin: "0 2px 8px" }}>завантаження…</div>}
          <TransactionList rows={rows} selectable={selectMode} selected={selected} onToggle={toggle} />
          {hasMore && (
            <div className="tx-more">
              <button className="tx-more-btn" disabled={isFetching} onClick={() => setLimit((l) => l + 100)}>
                {isFetching ? (
                  <span className="tx-more-spin" aria-hidden="true" />
                ) : (
                  <Icon name="chevron" size={16} className="tx-more-chev" />
                )}
                {isFetching ? "Завантаження…" : `Показати більше · ${rows.length}`}
              </button>
            </div>
          )}
        </div>
      </div>

      {selectMode && (
        <div className="bulkbar">
          <div className="bulkbar-inner">
            <span className="bulk-count">{selected.size} вибрано</span>
            <div className="bulk-actions">
              <div className="bulk-field">
                <Select value={null} clearable clearLabel="прибрати з групи" placeholder="У групу…" searchable
                  options={groupOptions} onChange={(v) => assignGroup(v == null ? null : Number(v))} disabled={!selected.size || bulkSaving} />
              </div>
              <button className="btn ghost" onClick={() => setShowGroupModal(true)} disabled={bulkSaving}>+ нова група</button>
              <div className="bulk-field">
                <Select value={null} placeholder="Категорія…" searchable
                  options={catOptions} onChange={(v) => assignCategory(v == null ? null : Number(v))} disabled={!selected.size || bulkSaving} />
              </div>
              <button className="btn ghost" onClick={markTransfer} disabled={!selected.size || bulkSaving}>Переказ</button>
              <button className="btn ghost" onClick={() => setSelected(new Set())} disabled={!selected.size}>Зняти</button>
            </div>
          </div>
        </div>
      )}

      {showGroupModal && (
        <GroupModal onClose={() => setShowGroupModal(false)} onCreated={(id) => assignGroup(id)} />
      )}
    </>
  );
}
