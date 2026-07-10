import { TxItem } from "./TxItem.tsx";
import type { TxRow } from "../store/api.ts";

interface Props {
  rows: TxRow[];
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
}

export function TransactionList({ rows, selectable, selected, onToggle }: Props) {
  if (!rows.length) return <div className="card empty">Порожньо</div>;
  return (
    <div className="ledger rows">
      {rows.map((t) => (
        <TxItem key={t.id} t={t} selectable={selectable} selected={selected?.has(t.id)} onToggle={onToggle} />
      ))}
    </div>
  );
}
