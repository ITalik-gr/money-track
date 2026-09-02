import { useGetTxAiChangesQuery, useRevertAiChangeMutation, useGetCategoriesQuery } from "../../store/api.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { useT } from "../../i18n/index.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import type { AiChange } from "../../store/api.ts";

const when = dateFmt({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * §AI-AUDIT — what the model changed about this operation, and one click to put it back.
 *
 * The app lets AI rewrite a transaction's category, its transfer flag and its understanding, from
 * enrichment, from the re-sweep and from the chat below. None of that used to leave a trace, so a
 * category could disagree with what the bank or the person had put there and nothing said who
 * decided that. "Why is this in Entertainment" is the question this answers.
 *
 * Renders nothing when nothing was changed — an empty audit trail is not a state worth a heading,
 * and on most operations it is the normal one.
 */
export function AiChangeLog({ txId }: { txId: string }) {
  const t = useT();
  const { data: changes = [] } = useGetTxAiChangesQuery(txId);
  const { data: cats = [] } = useGetCategoriesQuery();
  const [revert, { isLoading }] = useRevertAiChangeMutation();

  if (!changes.length) return null;

  const catName = (v: string | null) => {
    if (v == null) return t("audit.noCategory");
    return cats.find((c) => c.id === Number(v))?.name ?? `#${v}`;
  };

  // A stored value is text (three columns of three types share one nullable string), so it is
  // turned back into something readable HERE rather than at write time — the log has to stay
  // truthful about the raw value even if a category is later renamed.
  const show = (ch: AiChange, v: string | null) => {
    if (ch.field === "category_id" || ch.field === "real_category_id") return catName(v);
    if (ch.field === "is_transfer") return v === "1" ? t("audit.isTransfer") : t("audit.notTransfer");
    return v && v.trim() ? v : t("audit.empty");
  };

  async function undo(id: number) {
    try {
      await revert(id).unwrap();
      toast.success(t("audit.reverted"));
    } catch (e) { toast.error(errText(e)); }
  }

  return (
    <div className="audit">
      <div className="audit-head">{t("audit.head")}</div>
      <ul className="audit-list">
        {changes.map((ch) => (
          <li key={ch.id} className={ch.reverted_at != null ? "reverted" : ""}>
            <span className="audit-field">{t(`audit.field.${ch.field}` as "audit.field.category_id")}</span>
            <span className="audit-move">
              <span className="audit-old">{show(ch, ch.old_value)}</span>
              <span className="audit-arrow">→</span>
              <span className="audit-new">{show(ch, ch.new_value)}</span>
            </span>
            <span className="audit-meta">
              {t(`audit.source.${ch.source}` as "audit.source.chat")} · {when.format(ch.created_at * 1000)}
            </span>
            {ch.reverted_at != null
              // The row stays after an undo, labelled: knowing the AI did this AND that you
              // reversed it is more useful than the row disappearing as if nothing happened.
              ? <span className="audit-done">{t("audit.wasReverted")}</span>
              : <button className="btn sm ghost" disabled={isLoading} onClick={() => undo(ch.id)}>
                  {t("audit.undo")}
                </button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
