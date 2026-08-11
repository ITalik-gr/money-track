import { useMemo, useState } from "react";
import { useGetCategoriesQuery, useDeleteCategoryMutation, useLazyGetCategoryUsageQuery } from "../store/api.ts";
import { CategoryIcon } from "../components/ui/CategoryIcon.tsx";
import { CategoryModal } from "../components/planning/CategoryModal.tsx";
import { Select, type SelectOption } from "../components/ui/Select.tsx";
import { RulesCard } from "../components/planning/RulesCard.tsx";
import { CategoryGridSkeleton } from "../components/ui/Skeleton.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import { useT } from "../i18n/index.ts";
import type { Category } from "../../shared/types.ts";

const TRANSFER_CAT = 13; // «Перекази і зняття» — захищена

// Керування категоріями: редагувати наявні (навіть вбудовані — назва/колір/іконка/батько)
// і додавати нові. Ролап підкатегорій у батька зберігаємо (аналітика по COALESCE(parent_id,id)).
export function Categories() {
  const t = useT();
  // Скелет, а не порожнеча: `CatSection` віддає `null` для порожнього списку, тож поки запит
  // летів, сторінка була просто біла — гірше за будь-який плейсхолдер.
  const { data: cats = [], isLoading } = useGetCategoriesQuery();
  const [deleteCategory] = useDeleteCategoryMutation();
  const [fetchUsage] = useLazyGetCategoryUsageQuery();
  const [modal, setModal] = useState<{ open: boolean; cat: Category | null; parentId?: number | null; income?: boolean }>({ open: false, cat: null });
  const [del, setDel] = useState<{ cat: Category; usage: { transactions: number; tags: number; subcategories: number } } | null>(null);

  const { expense, income } = useMemo(() => groupByParent(cats), [cats]);

  async function askDelete(cat: Category) {
    if (cat.id === TRANSFER_CAT) { toast.error(t("cat.cannotDeleteTransfer")); return; }
    try {
      const usage = await fetchUsage(cat.id).unwrap();
      if (usage.transactions === 0 && usage.subcategories === 0) {
        await deleteCategory({ id: cat.id, reassign: null }).unwrap();
        toast.success(t("cat.deletedToast", { name: cat.name }));
      } else {
        setDel({ cat, usage });
      }
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("nav.categories")}</div>
          <div className="sub">{t("cat.sub")}</div>
        </div>
        <div className="page-head-actions">
          <button className="btn primary" onClick={() => setModal({ open: true, cat: null })}>＋ {t("cat.addNew")}</button>
        </div>
      </div>

      {isLoading ? <CategoryGridSkeleton /> : (
      <div className="stack" style={{ gap: 22 }}>
        <CatSection title={t("common.expenses")} groups={expense}
          onEdit={(c) => setModal({ open: true, cat: c })}
          onAddSub={(p) => setModal({ open: true, cat: null, parentId: p.id, income: !!p.is_income })}
          onDelete={askDelete} />
        <CatSection title={t("tx.list.typeIncome")} groups={income}
          onEdit={(c) => setModal({ open: true, cat: c })}
          onAddSub={(p) => setModal({ open: true, cat: null, parentId: p.id, income: !!p.is_income })}
          onDelete={askDelete} />
        {/* Rules live on this page, not in Settings: they are how a category gets ASSIGNED, and
            the person who wants one is already looking at the category list. */}
        <RulesCard />
      </div>
      )}

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
              toast.success(t("cat.deletedToast", { name: del.cat.name }));
            } catch (e) { toast.error(errText(e)); }
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
  const t = useT();
  const [target, setTarget] = useState<number | null>(null);
  // Категорії того ж типу (витрата/дохід), крім самої та її підкатегорій.
  const childIds = new Set(cats.filter((c) => c.parent_id === cat.id).map((c) => c.id));
  const options: SelectOption[] = cats
    .filter((c) => c.id !== cat.id && !childIds.has(c.id) && !!c.is_income === !!cat.is_income)
    .map((c) => ({ value: c.id, label: (c.parent_id ? "— " : "") + c.name, color: c.color, icon: c.icon }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>{t("cat.deleteTitle", { name: cat.name })}</h3></div>
        <div className="stack" style={{ gap: 12 }}>
          <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.5 }}>
            {t("cat.usagePrefix")} <b>{usage.transactions}</b> {t("cat.usageTxWord")}
            {usage.subcategories > 0 ? <> {t("cat.usageAndWord")} <b>{usage.subcategories}</b> {t("cat.usageSubWord")}</> : null}.
            {" "}{t("cat.usageWhere")}
          </p>
          <label className="stack" style={{ gap: 4 }}>
            <span className="label">{t("cat.moveToCategory")}</span>
            <Select value={target} options={options} searchable clearable clearLabel={t("cat.noCategoryOption")}
              placeholder={t("cat.noCategoryOption")} onChange={(v) => setTarget(v == null ? null : Number(v))} />
          </label>
          <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button className="btn ghost" onClick={onClose}>{t("common.cancel")}</button>
            <button className="btn danger" onClick={() => onConfirm(target)}>{t("cat.moveAndDelete")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CatSection({ title, groups, onEdit, onAddSub, onDelete }: {
  title: string; groups: Group[]; onEdit: (c: Category) => void; onAddSub: (p: Category) => void; onDelete: (c: Category) => void;
}) {
  const t = useT();
  if (!groups.length) return null;
  return (
    <section>
      <div className="section-head"><h2>{title}</h2><span className="label">{t("cat.categoriesCount", { n: groups.length })}</span></div>
      <div className="cat-grid">
        {groups.map(({ parent, children }) => (
          <div key={parent.id} className="cat-card">
            <div className="cat-card-head">
              <span className="cat-ico" style={{ background: parent.color ?? "var(--muted)" }}><CategoryIcon slug={parent.icon} size={20} /></span>
              <div className="cat-card-title">
                <div className="cat-card-name">{parent.name}</div>
                {parent.is_custom ? <span className="cat-badge">{t("cat.customBadge")}</span> : null}
              </div>
              <div className="cat-card-actions">
                <button className="icon-mini" onClick={() => onEdit(parent)} aria-label={t("common.edit")}><Icon name="edit" size={15} /></button>
                {parent.id !== TRANSFER_CAT ? (
                  <button className="icon-mini" onClick={() => onDelete(parent)} aria-label={t("common.delete")}><Icon name="trash" size={15} /></button>
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
                  <span className="cat-sub-x" onClick={(e) => { e.stopPropagation(); onDelete(ch); }} aria-label={t("common.delete")}>✕</span>
                </button>
              ))}
              <button className="cat-sub cat-sub-add" onClick={() => onAddSub(parent)}>＋ {t("cat.addSubcategory")}</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
