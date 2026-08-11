import { Link } from "react-router-dom";
import { useGetAiChangesQuery, useRevertAiChangeMutation, useGetCategoriesQuery } from "../../store/api.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { useT } from "../../i18n/index.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";
import { EmptyCard } from "../ui/EmptyCard.tsx";
import type { AiChange } from "../../store/api.ts";

const when = dateFmt({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * §AI-AUDIT, the wide view: what the model has been doing to the data lately.
 *
 * The per-transaction log answers "why is THIS one in Entertainment". This answers the question
 * that comes before it — "how much is the AI actually deciding for me" — and it is the honest
 * companion to the spend card next to it: one says what the model cost, this says what it changed.
 *
 * Every row links to its operation, because a change is only judgeable next to the thing it
 * changed; a log you cannot navigate out of is a wall of text.
 */
export function AiActivityCard() {
  const t = useT();
  const { data: changes = [] } = useGetAiChangesQuery(50);
  const { data: cats = [] } = useGetCategoriesQuery();
  const [revert, { isLoading }] = useRevertAiChangeMutation();

  const show = (ch: AiChange, v: string | null) => {
    if (ch.field === "category_id") {
      return v == null ? t("audit.noCategory") : cats.find((c) => c.id === Number(v))?.name ?? `#${v}`;
    }
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
    <section className="card set-full">
      <div className="set-head">
        <h2>{t("audit.wideTitle")}</h2>
        <span className="label">{t("audit.wideSub")}</span>
      </div>
      {/* Not `return null` on empty: this card sits in a grid, and an empty half reads as broken
          layout rather than as "nothing happened" (a rule this repo has paid for three times). */}
      {changes.length === 0 ? (
        <EmptyCard icon="sparkle" title={t("audit.emptyTitle")} hint={t("audit.emptyHint")} />
      ) : (
        <ul className="audit-list audit-wide">
          {changes.map((ch) => (
            <li key={ch.id} className={ch.reverted_at != null ? "reverted" : ""}>
              <Link className="audit-tx" to={`/tx/${ch.tx_id}`} title={ch.merchant ?? ch.tx_id}>
                {ch.merchant ?? t("audit.noName")}
              </Link>
              <span className="audit-move">
                <span className="audit-old">{show(ch, ch.old_value)}</span>
                <span className="audit-arrow">→</span>
                <span className="audit-new">{show(ch, ch.new_value)}</span>
              </span>
              <span className="audit-meta">
                {t(`audit.source.${ch.source}` as "audit.source.chat")} · {when.format(ch.created_at * 1000)}
              </span>
              {ch.reverted_at != null
                ? <span className="audit-done">{t("audit.wasReverted")}</span>
                : <button className="btn sm ghost" disabled={isLoading} onClick={() => undo(ch.id)}>
                    {t("audit.undo")}
                  </button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
