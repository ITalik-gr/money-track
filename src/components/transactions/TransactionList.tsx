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
  return (
    <div className="ledger rows">
      {rows.map((t) => (
        <TxItem key={t.id} t={t} selectable={selectable} selected={selected?.has(t.id)} onToggle={onToggle} />
      ))}
    </div>
  );
}
