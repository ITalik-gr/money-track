import { useMemo, useState } from "react";
import { useGetCategoriesQuery, useDeleteCategoryMutation, useLazyGetCategoryUsageQuery } from "../store/api.ts";
import { CategoryIcon } from "../components/CategoryIcon.tsx";
import { CategoryModal } from "../components/CategoryModal.tsx";
import { Select, type SelectOption } from "../components/Select.tsx";
import { Icon } from "../components/Icon.tsx";
import { toast } from "../lib/toast.ts";
import type { Category } from "../../shared/types.ts";

const TRANSFER_CAT = 13; // «Перекази і зняття» — захищена

// Керування категоріями: редагувати наявні (навіть вбудовані — назва/колір/іконка/батько)
// і додавати нові. Ролап підкатегорій у батька зберігаємо (аналітика по COALESCE(parent_id,id)).
export function Categories() {
  const { data: cats = [] } = useGetCategoriesQuery();
  const [deleteCategory] = useDeleteCategoryMutation();
  const [fetchUsage] = useLazyGetCategoryUsageQuery();
  const [modal, setModal] = useState<{ open: boolean; cat: Category | null; parentId?: number | null; income?: boolean }>({ open: false, cat: null });
  const [del, setDel] = useState<{ cat: Category; usage: { transactions: number; tags: number; subcategories: number } } | null>(null);

  const { expense, income } = useMemo(() => groupByParent(cats), [cats]);

  async function askDelete(cat: Category) {
    if (cat.id === TRANSFER_CAT) { toast.error("Цю категорію видаляти не можна."); return; }
    try {
      const usage = await fetchUsage(cat.id).unwrap();
      if (usage.transactions === 0 && usage.subcategories === 0) {
        await deleteCategory({ id: cat.id, reassign: null }).unwrap();
        toast.success(`Категорію «${cat.name}» видалено`);
      } else {
        setDel({ cat, usage });
      }
    } catch (e) { toast.error(String(e)); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">Категорії</div>
          <div className="sub">Налаштуй наявні або додай свої — назва, колір, іконка, вкладеність.</div>
        </div>
        <div className="page-head-actions">
          <button className="btn primary" onClick={() => setModal({ open: true, cat: null })}>＋ нова категорія</button>
        </div>
      </div>

      <div className="stack" style={{ gap: 22 }}>
        <CatSection title="Витрати" groups={expense}
          onEdit={(c) => setModal({ open: true, cat: c })}
          onAddSub={(p) => setModal({ open: true, cat: null, parentId: p.id, income: !!p.is_income })}
          onDelete={askDelete} />
        <CatSection title="Доходи" groups={income}
          onEdit={(c) => setModal({ open: true, cat: c })}
          onAddSub={(p) => setModal({ open: true, cat: null, parentId: p.id, income: !!p.is_income })}
          onDelete={askDelete} />
      </div>

      {modal.open && (
        <CategoryModal category={modal.cat} defaultParentId={modal.parentId} defaultIncome={modal.income}
          onClose={() => setModal({ open: false, cat: null })} />
      )}
      {del && (
        <DeleteCategoryModal cat={del.cat} usage={del.usage} cats={cats}
          onClose={() => setDel(null)}
          onConfirm={async (reassign) => {
            try {
              await deleteCategory({ id: del.cat.id, reassign }).unwrap();
              toast.success(`Категорію «${del.cat.name}» видалено`);
            } catch (e) { toast.error(String(e)); }
            setDel(null);
          }} />
      )}
    </>
  );
}

interface Group { parent: Category; children: Category[] }

function groupByParent(cats: Category[]) {
  const tops = cats.filter((c) => c.parent_id == null);
  const build = (income: boolean): Group[] =>
    tops
      .filter((p) => !!p.is_income === income)
      .map((parent) => ({ parent, children: cats.filter((c) => c.parent_id === parent.id) }));
  return { expense: build(false), income: build(true) };
}

// Діалог перенесення транзакцій перед видаленням категорії (§CAT2).
function DeleteCategoryModal({ cat, usage, cats, onClose, onConfirm }: {
  cat: Category; usage: { transactions: number; tags: number; subcategories: number };
  cats: Category[]; onClose: () => void; onConfirm: (reassign: number | null) => void;
}) {
  const [target, setTarget] = useState<number | null>(null);
  // Категорії того ж типу (витрата/дохід), крім самої та її підкатегорій.
  const childIds = new Set(cats.filter((c) => c.parent_id === cat.id).map((c) => c.id));
  const options: SelectOption[] = cats
    .filter((c) => c.id !== cat.id && !childIds.has(c.id) && !!c.is_income === !!cat.is_income)
    .map((c) => ({ value: c.id, label: (c.parent_id ? "— " : "") + c.name, color: c.color, icon: c.icon }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>Видалити «{cat.name}»?</h3></div>
        <div className="stack" style={{ gap: 12 }}>
          <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.5 }}>
            До цієї категорії прив'язано <b>{usage.transactions}</b> операцій
            {usage.subcategories > 0 ? <> та <b>{usage.subcategories}</b> підкатегорій</> : null}.
            Куди перенести їх?
          </p>
          <label className="stack" style={{ gap: 4 }}>
            <span className="label">перенести в категорію</span>
            <Select value={target} options={options} searchable clearable clearLabel="— без категорії"
              placeholder="— без категорії" onChange={(v) => setTarget(v == null ? null : Number(v))} />
          </label>
          <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button className="btn ghost" onClick={onClose}>Скасувати</button>
            <button className="btn danger" onClick={() => onConfirm(target)}>Перенести й видалити</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CatSection({ title, groups, onEdit, onAddSub, onDelete }: {
  title: string; groups: Group[]; onEdit: (c: Category) => void; onAddSub: (p: Category) => void; onDelete: (c: Category) => void;
}) {
  if (!groups.length) return null;
  return (
    <section>
      <div className="section-head"><h2>{title}</h2><span className="label">{groups.length} категорій</span></div>
      <div className="cat-grid">
        {groups.map(({ parent, children }) => (
          <div key={parent.id} className="cat-card">
            <div className="cat-card-head">
              <span className="cat-ico" style={{ background: parent.color ?? "var(--muted)" }}><CategoryIcon slug={parent.icon} size={20} /></span>
              <div className="cat-card-title">
                <div className="cat-card-name">{parent.name}</div>
                {parent.is_custom ? <span className="cat-badge">своя</span> : null}
              </div>
              <div className="cat-card-actions">
                <button className="icon-mini" onClick={() => onEdit(parent)} aria-label="Редагувати"><Icon name="edit" size={15} /></button>
                {parent.id !== TRANSFER_CAT ? (
                  <button className="icon-mini" onClick={() => onDelete(parent)} aria-label="Видалити"><Icon name="trash" size={15} /></button>
                ) : null}
              </div>
            </div>
            <div className="cat-subs">
              {children.map((ch) => (
                <button key={ch.id} className="cat-sub" onClick={() => onEdit(ch)}>
                  <span className="cat-sub-dot" style={{ background: ch.color ?? parent.color ?? "var(--muted)" }}>
                    <CategoryIcon slug={ch.icon} size={12} />
                  </span>
                  {ch.name}
                  <span className="cat-sub-x" onClick={(e) => { e.stopPropagation(); onDelete(ch); }} aria-label="Видалити">✕</span>
                </button>
              ))}
              <button className="cat-sub cat-sub-add" onClick={() => onAddSub(parent)}>＋ підкатегорія</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
