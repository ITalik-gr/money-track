import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { InfoTip } from "./InfoTip.tsx";
import { ErrorNote } from "./ErrorNote.tsx";
import {
  useGetKnowledgeQuery,
  useLazyGetKnowledgeDocQuery,
  useCreateKnowledgeDocMutation,
  useSaveKnowledgeDocMutation,
  useDeleteKnowledgeDocMutation,
  type KnowledgeMeta,
} from "../store/api.ts";
import { errText } from "../lib/errors.ts";
import { toast } from "../lib/toast.ts";

// Корпус знань (§A5): те, що AI-чат читає як стабільний контекст ПОВЕРХ даних користувача.
// Два шари: заводські доки (у коді) і власні нотатки/заміни (таблиця `knowledge_docs`).
// Док «Як Money Track рахує цифри» позначений locked — він описує канон розрахунків, і
// підміна тексту дала б AI, що пояснює цифри інакше, ніж їх рахує застосунок.
export function KnowledgeCorpusCard() {
  const { data, error, refetch } = useGetKnowledgeQuery();
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const docs = data?.docs ?? [];
  const builtin = docs.filter((d) => d.kind === "builtin");
  const mine = docs.filter((d) => d.kind === "user");
  const usedPct = data ? Math.min(100, Math.round((data.user_chars / data.user_limit) * 100)) : 0;

  return (
    <div className="card corpus-card">
      <div className="ai-head">
        <span className="ai-badge soft"><Icon name="folder" size={18} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="ai-title">
            Корпус знань
            <InfoTip>
              Довідник, який AI-чат читає як стабільний контекст, — тож поради спираються на ці
              правила, а не на загальні уявлення. Заводські документи можна переписати під себе
              або вимкнути; методологію розрахунків — ні, вона мусить збігатися з тим, як рахує застосунок.
            </InfoTip>
          </div>
          <div className="label">що чат знає крім твоїх даних</div>
        </div>
        <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => setEditing({ id: null })}>
          <Icon name="plus" size={13} /> Додати
        </button>
      </div>

      {error && <ErrorNote error={error} what="корпус знань" onRetry={refetch} />}

      <div className="corpus-list">
        {builtin.map((d) => <DocRow key={d.id} d={d} onEdit={() => setEditing({ id: d.id })} />)}
      </div>

      <div className="corpus-sec">
        <span className="label">мої нотатки</span>
        {data && <span className="corpus-quota" title={`${data.user_chars} із ${data.user_limit} символів`}>{usedPct}% місця</span>}
      </div>
      {mine.length ? (
        <div className="corpus-list">
          {mine.map((d) => <DocRow key={d.id} d={d} onEdit={() => setEditing({ id: d.id })} />)}
        </div>
      ) : (
        <p className="corpus-hint">
          Порожньо. Додай своє: правила, домовленості, контекст («орендар платить половину комуналки»,
          «крипту не чіпаю до 2028»). Чат читатиме це в кожній відповіді.
        </p>
      )}

      {editing && <DocEditor id={editing.id} docLimit={data?.doc_limit ?? 20000} onClose={() => setEditing(null)} />}
    </div>
  );
}

function DocRow({ d, onEdit }: { d: KnowledgeMeta; onEdit: () => void }) {
  return (
    // Нативний `title` тут прибрано: він спливав під курсором і перекривав шапку картки,
    // а стрілка праворуч і так каже, що рядок відкривається.
    <button className={`corpus-doc${d.enabled ? "" : " off"}`} onClick={onEdit}>
      <Icon name={d.locked ? "check" : "report"} size={15} />
      <div style={{ minWidth: 0 }}>
        <div className="corpus-doc-title">
          {d.title}
          {d.locked && <span className="corpus-tag">канон</span>}
          {d.overridden && <span className="corpus-tag edited">змінено</span>}
          {!d.enabled && <span className="corpus-tag off">вимкнено</span>}
        </div>
        <div className="corpus-doc-sum">{d.summary || `${d.chars} символів`}</div>
      </div>
      <Icon name="chevron" size={14} />
    </button>
  );
}

// Редактор одного документа. id=null → нова власна нотатка.
function DocEditor({ id, docLimit, onClose }: { id: string | null; docLimit: number; onClose: () => void }) {
  const [fetchDoc, { data: doc, isFetching, error: loadErr }] = useLazyGetKnowledgeDocQuery();
  const [create, { isLoading: creating }] = useCreateKnowledgeDocMutation();
  const [save, { isLoading: saving }] = useSaveKnowledgeDocMutation();
  const [del] = useDeleteKnowledgeDocMutation();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [enabled, setEnabled] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (id) void fetchDoc(id); }, [id, fetchDoc]);
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);
  useEffect(() => {
    if (!doc || doc.id !== id) return;
    setTitle(doc.title); setSummary(doc.summary); setBody(doc.body); setEnabled(doc.enabled);
  }, [doc, id]);

  const locked = !!doc?.locked;
  const busy = creating || saving;
  const over = body.length > docLimit;

  async function onSave() {
    try {
      if (id) await save({ id, title, summary, body, enabled }).unwrap();
      else await create({ title, summary, body }).unwrap();
      toast.success("Збережено — чат використає це з наступного питання");
      onClose();
    } catch (e) { toast.error(errText(e)); }
  }

  async function onReset() {
    const own = doc?.kind === "user";
    if (!confirm(own ? "Видалити нотатку?" : "Повернути заводський текст документа?")) return;
    try { await del(id!).unwrap(); toast.success(own ? "Видалено" : "Повернуто заводський текст"); onClose(); }
    catch (e) { toast.error(errText(e)); }
  }

  // Файл читаємо на КЛІЄНТІ й кладемо в поле тексту: користувач бачить, що саме піде в промт,
  // і може підправити. Сховище файлів (R2/PDF) — свідомо поза цим кроком.
  function onFile(f: File | undefined) {
    if (!f) return;
    if (f.size > docLimit * 4) { toast.error(`Файл завеликий — максимум ~${Math.round(docLimit / 1000)} тис. символів`); return; }
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result ?? "");
      setBody(text.slice(0, docLimit));
      if (!title.trim()) setTitle(f.name.replace(/\.(md|txt|markdown)$/i, ""));
      if (text.length > docLimit) toast.info("Текст обрізано до ліміту документа");
    };
    r.readAsText(f);
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal modal-wide doc-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{id ? "Документ корпусу" : "Нова нотатка"}</h3>
          <button className="modal-x" onClick={onClose} aria-label="Закрити">✕</button>
        </div>

        {loadErr && <ErrorNote error={loadErr} what="документ" />}
        {isFetching && !doc ? <div className="label">Завантаження…</div> : (
          <div className="stack" style={{ gap: 12 }}>
            {locked && (
              <div className="fb-note" role="status">
                <Icon name="info" size={15} />
                <div>
                  <b>Тільки читання.</b> Цей документ описує, як застосунок рахує подушку, burn,
                  runway й решту чисел. Якщо дозволити його переписати, AI пояснюватиме цифри не так,
                  як їх рахує код.
                </div>
              </div>
            )}

            <label className="stack" style={{ gap: 5 }}>
              <span className="label">назва</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={locked} placeholder="напр. «Мої правила щодо витрат»" />
            </label>
            <label className="stack" style={{ gap: 5 }}>
              <span className="label">короткий опис</span>
              <input value={summary} onChange={(e) => setSummary(e.target.value)} disabled={locked} maxLength={200} placeholder="один рядок — що це за документ" />
            </label>
            <label className="stack" style={{ gap: 5 }}>
              <span className="label">
                текст <span className="muted">markdown · {body.length} / {docLimit}</span>
              </span>
              <textarea className={`doc-body${over ? " over" : ""}`} value={body} rows={14} disabled={locked}
                onChange={(e) => setBody(e.target.value)} placeholder="Пиши як звичайний текст або markdown. Це піде в контекст чату як є." />
            </label>

            {!locked && (
              <div className="doc-actions">
                <input ref={fileRef} type="file" accept=".md,.txt,.markdown,text/plain,text/markdown" hidden
                  onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
                <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>
                  <Icon name="export" size={13} /> З файлу (.md/.txt)
                </button>
                {id && (
                  <label className="doc-toggle">
                    <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                    використовувати в чаті
                  </label>
                )}
              </div>
            )}

            <div className="row" style={{ gap: 8, marginTop: 4 }}>
              {!locked && (
                <button className="btn primary" onClick={onSave} disabled={busy || over || !title.trim() || !body.trim()}>
                  {busy ? "Зберігаю…" : "Зберегти"}
                </button>
              )}
              <button className="btn ghost" onClick={onClose}>{locked ? "Закрити" : "Скасувати"}</button>
              {id && !locked && (doc?.kind === "user" || doc?.overridden) && (
                <button className="btn ghost sm danger-text" style={{ marginLeft: "auto" }} onClick={onReset}>
                  {doc?.kind === "user" ? "Видалити" : "Повернути заводський"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
