// "Mark the similar ones too" (2026-08-13).
//
// The case it was asked for: a Raiffeisen export writes every card-to-card transfer as
// "Money transfers: 4441 11** **** 4932" with a different card each time, so fixing one of them
// fixes exactly one — and a statement carries dozens. The same is true of any bank whose export
// has no MCC: correcting one row and having the other twenty stay wrong is the fastest way to stop
// correcting anything at all.
//
// Deliberately NOT a single "apply to everything similar" button. A bulk edit fired blind touches
// precisely the rows nobody is looking at, so what would change is listed, and each line can be
// unticked.
import { useState } from "react";
import { Link } from "react-router";
import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { Icon } from "../ui/Icon.tsx";
import { Money } from "../ui/Money.tsx";
import { useGetSimilarQuery, useBulkEditTransactionsMutation } from "../../store/api.ts";
import { toast } from "../../lib/toast.ts";
import { errText } from "../../lib/errors.ts";

export function SimilarTx({ txId, categoryId, isTransfer }: {
  txId: string;
  categoryId: number | null;
  isTransfer: boolean;
}) {
  const t = useT();
  const { data } = useGetSimilarQuery(txId);
  const [bulk, { isLoading }] = useBulkEditTransactionsMutation();
  // `undefined` = the server's suggestion still stands; a Set once the person has touched anything.
  const [chosen, setChosen] = useState<Set<string> | null>(null);

  const items = data?.items ?? [];
  if (!items.length) return null;

  // The server decides what is pre-ticked (`suggested`): a row with no category is a gap to fill,
  // a row carrying a different one is a decision someone already made. Both are offered; only the
  // first is ticked, because an app that silently overwrites work already done is worse than one
  // that asks twice.
  const selected = chosen ?? new Set(items.filter((i) => i.suggested).map((i) => i.id));

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setChosen(next);
  }

  async function apply() {
    const ids = [...selected];
    if (!ids.length) return;
    try {
      await bulk({ ids, category_id: categoryId, is_transfer: isTransfer }).unwrap();
      toast.success(t("tx.similarApplied", { n: ids.length }));
      setChosen(new Set());
    } catch (e) {
      toast.error(errText(e));
    }
  }

  return (
    <div className="card sim-card">
      <div className="sim-head">
        <span className="sim-title"><Icon name="repeat" size={16} />{t("tx.similarTitle", { n: items.length })}</span>
      </div>
      <p className="sim-sub">{t("tx.similarHint")}</p>

      <ul className="sim-list">
        {items.map((i) => (
          <li key={i.id} className="sim-row">
            <label className="sim-pick">
              <input type="checkbox" checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
            </label>
            {/* The row links out: deciding about an operation you cannot open is deciding blind. */}
            <Link to={`/tx/${i.id}`} className="sim-main">
              <span className="sim-name">{i.merchant ?? t("tx.noName")}</span>
              <span className="sim-meta">
                {dateFmt({ dateStyle: "short" }).format(i.time * 1000)}
                {" · "}
                {/* What it is filed as TODAY — the whole question is whether that should change. */}
                {i.category_name ?? t("tx.noCategory")}
              </span>
            </Link>
            <Money minor={i.amount} currency={i.currency_code} />
          </li>
        ))}
      </ul>

      <button className="btn" onClick={apply} disabled={isLoading || !selected.size}>
        {isLoading ? "…" : t("tx.similarApply", { n: selected.size })}
      </button>
    </div>
  );
}
