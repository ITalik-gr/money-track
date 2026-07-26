import { useEffect, useMemo, useState } from "react";
import {
  useGetCategoriesQuery,
  useReviewTransfersMutation,
  useReviewTransferOneMutation,
  useSaveTransferReviewMutation,
  type TransferReviewRow,
} from "../store/api.ts";
import { Select } from "./Select.tsx";
import type { SelectOption } from "./Select.tsx";
import { MerchantLogo } from "./MerchantLogo.tsx";
import { Icon } from "./Icon.tsx";
import { formatMinor, formatDate, currencySign } from "../lib/format.ts";
import { toast } from "../lib/toast.ts";
import { errText } from "../lib/errors.ts";
import { useT } from "../i18n/index.ts";
import type { Category } from "../../shared/types.ts";

// §R2-ST4 + §C1/§C2: інтерактивний попап-рев'ю реальної категорії переказів/знять.
// Велика 2-колонкова модалка (нічого не обрізається), повна інфо про операцію,
// на кожен рядок — поле «описати для AI» (перепрогнати саме цю операцію з підказкою).
function categoryOptions(cats: Category[] | undefined): SelectOption[] {
  const list = (cats ?? []).filter((c) => !c.is_income);
  const tops = list.filter((c) => c.parent_id == null);
  const out: SelectOption[] = [];
  for (const p of tops) {
    out.push({ value: p.id, label: p.name, color: p.color, icon: p.icon });
    for (const ch of list.filter((c) => c.parent_id === p.id)) {
      out.push({ value: ch.id, label: ch.name, color: ch.color ?? p.color, icon: ch.icon, indent: true });
    }
  }
  return out;
}

interface EditRow extends TransferReviewRow { chosen: number | null; learn: boolean; hint: string; rerunning?: boolean }

export function TransferReviewModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { data: cats } = useGetCategoriesQuery();
  const [review, { isLoading: loading }] = useReviewTransfersMutation();
  const [reviewOne] = useReviewTransferOneMutation();
  const [save, { isLoading: saving }] = useSaveTransferReviewMutation();
  const [rows, setRows] = useState<EditRow[]>([]);
  const [remaining, setRemaining] = useState(0);
  const [ran, setRan] = useState(false);
  const catOptions = useMemo(() => categoryOptions(cats), [cats]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  async function runBatch() {
    try {
      const r = await review(12).unwrap();
      setRows((prev) => [
        ...prev,
        ...r.rows.map((x) => ({ ...x, chosen: x.real_category_id, learn: false, hint: "" })),
      ]);
      setRemaining(r.remaining);
      setRan(true);
    } catch (e) {
      toast.error(errText(e));
    }
  }

  // Автозапуск першого батчу при відкритті.
  useEffect(() => { runBatch(); /* eslint-disable-next-line */ }, []);

  function patchRow(id: string, patch: Partial<EditRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  // §C2: перепрогнати ОДИН рядок через AI з підказкою користувача.
  async function reRun(row: EditRow) {
    if (!row.hint.trim() || row.rerunning) return;
    patchRow(row.id, { rerunning: true });
    try {
      const res = await reviewOne({ id: row.id, hint: row.hint }).unwrap();
      patchRow(row.id, {
        chosen: res.real_category_id, note: res.note,
        needs_attention: res.needs_attention, rerunning: false,
      });
      toast.success(t("trev.aiReviewedToast"));
    } catch (e) {
      patchRow(row.id, { rerunning: false });
      toast.error(errText(e));
    }
  }

  async function saveAll() {
    try {
      await save({ items: rows.map((r) => ({ id: r.id, real_category_id: r.chosen, learn: r.learn })) }).unwrap();
      toast.success(t("trev.savedToast", { n: rows.length }));
      onClose();
    } catch (e) {
      toast.error(errText(e));
    }
  }

  const attention = rows.filter((r) => r.needs_attention).length;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal modal-review" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 className="h-ico"><Icon name="spark" size={17} />{t("trev.title")}</h3>
          <button className="modal-x" onClick={onClose} aria-label={t("common.close")}>✕</button>
        </div>

        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          {t("trev.intro")}
          {attention > 0 && <> <b style={{ color: "var(--warn, #c9871a)" }}>{attention}</b>{t("trev.needAttentionSuffix")}</>}
        </p>

        {loading && rows.length === 0 && <div className="empty">{t("trev.analyzing")}</div>}
        {ran && rows.length === 0 && !loading && <div className="empty">{t("trev.noneFound")}</div>}

        {rows.length > 0 && (
          <div className="rev-grid">
            {rows.map((r) => (
              <div key={r.id} className={`rev-card ${r.needs_attention ? "attn" : ""}`}>
                <div className="rev-card-head">
                  <MerchantLogo merchant={r.merchant} color="var(--c-plum, var(--accent))" fallbackLabel={r.merchant ?? r.comment} transfer />
                  <div className="rev-card-title">
                    <div className="rev-name">
                      <span className="rev-name-txt">{r.merchant ?? r.comment ?? t("chat.txFallback")}</span>
                      {r.needs_attention && <span className="rev-badge">{t("trev.needsAttentionBadge")}</span>}
                    </div>
                    <div className="rev-meta">
                      {formatMinor(Math.abs(r.amount), { decimals: false })} {currencySign(r.currency_code)} · {formatDate(r.time)}
                    </div>
                  </div>
                </div>

                {r.comment && r.merchant && r.comment !== r.merchant && (
                  <div className="rev-desc">{r.comment}</div>
                )}
                {r.note && <div className="rev-note">💡 {r.note}</div>}

                <div className="rev-pick">
                  <span className="label">{t("trev.whatFor")}</span>
                  <Select value={r.chosen} options={catOptions} searchable clearable clearLabel={t("trev.realTransferClear")}
                    placeholder={t("trev.whatForPlaceholder")} onChange={(v) => patchRow(r.id, { chosen: v == null ? null : Number(v) })} />
                </div>

                <div className="rev-hint">
                  <input
                    placeholder={t("trev.describeForAiPlaceholder")}
                    value={r.hint}
                    onChange={(e) => patchRow(r.id, { hint: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && reRun(r)}
                  />
                  <button className="btn ghost" disabled={!r.hint.trim() || r.rerunning} onClick={() => reRun(r)}>
                    {r.rerunning ? "…" : <><Icon name="spark" size={14} />AI</>}
                  </button>
                </div>

                <label className="rev-learn" title={t("trev.rememberSimilarTitle")}>
                  <input type="checkbox" checked={r.learn} onChange={() => patchRow(r.id, { learn: !r.learn })} />
                  <span>{t("trev.rememberSimilar")}</span>
                </label>
              </div>
            ))}
          </div>
        )}

        <div className="rev-foot">
          <span className="muted" style={{ fontSize: 12.5 }}>
            {rows.length ? t("trev.inListCount", { n: rows.length }) : ""}{remaining > 0 ? t("trev.moreUnmarked", { n: remaining }) : ""}
          </span>
          <div className="row" style={{ gap: 8 }}>
            {remaining > 0 && (
              <button className="btn ghost" onClick={runBatch} disabled={loading}>
                {loading ? t("trev.analyzingBtn") : t("trev.moreBtn", { n: Math.min(remaining, 12) })}
              </button>
            )}
            <button className="btn ghost" onClick={onClose}>{t("common.close")}</button>
            <button className="btn primary" onClick={saveAll} disabled={saving || rows.length === 0}>
              {saving ? t("trev.savingBtn") : t("trev.saveAllBtn")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
