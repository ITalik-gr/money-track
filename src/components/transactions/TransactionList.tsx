import { TxItem } from "./TxItem.tsx";
import type { TxRow } from "../../store/api.ts";
import { useT } from "../../i18n/index.ts";

interface Props {
  rows: TxRow[];
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  /** Осмислена порожнеча (напр. фільтр-залежна). Дефолт — нейтральне «Порожньо». */
  empty?: string;
}

export function TransactionList({ rows, selectable, selected, onToggle, empty }: Props) {
  const t = useT();
  if (!rows.length) return <div className="card empty">{empty ?? t("common.empty")}</div>;
  // §VOID-PAIR: a cancellation whose purchase is on screen is shown BY that purchase, not beside
  // it. When the purchase is not loaded (another page, an income-only filter) the row stays.
  const ids = new Set(rows.map((r) => r.id));
  const shown = rows.filter((r) => !(r.voids && ids.has(r.voids)));
  return (
    <div className="ledger rows">
      {shown.map((t) => (
        <TxItem key={t.id} t={t} selectable={selectable} selected={selected?.has(t.id)} onToggle={onToggle} />
      ))}
    </div>
  );
}
