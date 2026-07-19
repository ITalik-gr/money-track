import { useMemo, useState } from "react";
import { Select } from "./Select.tsx";
import { Icon } from "./Icon.tsx";
import { formatMinor, currencySign } from "../lib/format.ts";
import { toast } from "../lib/toast.ts";
import { useGetTxSplitsQuery, useSetTxSplitsMutation } from "../store/api.ts";
import type { Category } from "../../shared/types.ts";

// §SPLIT: поділ витрати на кілька категорій (напр. супермаркет: продукти + побутхімія).
// Суми в ГРН (позитивні), сходяться до |суми операції|; зберігаємо як від'ємні копійки.
type Row = { category_id: number | null; major: string };
const toMinor = (major: string) => Math.round(Number(major.replace(",", ".")) * 100) || 0;

export function TxSplitEditor({ txId, amount, currency, cats }: {
  txId: string; amount: number; currency: number; cats: Category[] | undefined;
}) {
  const { data: splits } = useGetTxSplitsQuery(txId);
  const [save, { isLoading }] = useSetTxSplitsMutation();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);

  const totalMinor = Math.abs(amount);
  const sign = currencySign(currency);
  const catOptions = useMemo(
    () => (cats ?? []).map((c) => ({ value: c.id, label: c.parent_id ? `— ${c.name}` : c.name, color: c.color ?? undefined })),
    [cats],
  );
  const has = (splits?.length ?? 0) > 0;
  const sumMinor = rows.reduce((s, r) => s + toMinor(r.major), 0);
  const remainder = totalMinor - sumMinor;
  const valid = rows.length >= 2 && remainder === 0 && rows.every((r) => r.category_id != null && toMinor(r.major) > 0);

  function begin() {
    // Стартуємо з наявних частин або з одного рядка на всю суму + порожній.
    if (has && splits) setRows(splits.map((s) => ({ category_id: s.category_id, major: (Math.abs(s.amount) / 100).toFixed(2) })));
    else setRows([{ category_id: null, major: (totalMinor / 100).toFixed(2) }, { category_id: null, major: "" }]);
    setEditing(true);
  }
  async function commit(next: Row[] | null) {
    try {
      const payload = next === null ? [] : next.map((r) => ({ category_id: r.category_id as number, amount: -toMinor(r.major) }));
      await save({ id: txId, splits: payload }).unwrap();
      toast.success(next === null ? "Поділ прибрано" : "Операцію розділено");
      setEditing(false);
    } catch (e) {
      toast.error((e as { data?: { error?: string } })?.data?.error ?? "Не вдалося зберегти поділ");
    }
  }

  // Витрата, поділена — зведена картка (не в режимі редагування).
  if (has && !editing) {
    return (
      <div className="card split-card">
        <div className="section-head"><h3>Розділено на категорії</h3><button className="btn sm ghost" onClick={begin}>Редагувати</button></div>
        <div className="split-view">
          {splits!.map((s) => (
            <div className="split-vrow" key={s.id}>
              <span className="split-cat"><span className="d" style={{ background: s.category_color ?? "var(--muted)" }} />{s.category_name ?? "категорія"}</span>
              <span className="split-amt">{formatMinor(Math.abs(s.amount), { decimals: false })} {sign}</span>
            </div>
          ))}
        </div>
        <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => commit(null)} disabled={isLoading}>Прибрати поділ</button>
      </div>
    );
  }

  if (!editing) {
    return (
      <div className="card split-card">
        <div className="split-empty">
          <div>
            <div className="split-empty-t">Розділити на категорії</div>
            <div className="split-empty-s">Одна покупка → кілька категорій (напр. продукти + побутхімія). Впливає на аналітику.</div>
          </div>
          <button className="btn sm" onClick={begin}><Icon name="swap" /> Розділити</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card split-card">
      <div className="section-head"><h3>Поділ на категорії</h3></div>
      <div className="split-rows">
        {rows.map((r, i) => (
          <div className="split-row" key={i}>
            <Select
              value={r.category_id}
              options={catOptions}
              onChange={(v) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, category_id: v == null ? null : Number(v) } : x)))}
              placeholder="категорія"
              searchable
            />
            <div className="split-amt-in">
              <input inputMode="decimal" value={r.major} placeholder="0.00"
                onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, major: e.target.value } : x)))} />
              <span className="split-sign">{sign}</span>
            </div>
            <button className="btn sm icon ghost" aria-label="Прибрати" disabled={rows.length <= 2}
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><Icon name="trash" /></button>
          </div>
        ))}
      </div>
      <button className="btn sm ghost" onClick={() => setRows((rs) => [...rs, { category_id: null, major: "" }])}><Icon name="plus" /> Додати частину</button>

      <div className={`split-remainder ${remainder === 0 ? "ok" : ""}`}>
        {remainder === 0 ? "✓ сходиться" : `Залишок: ${formatMinor(remainder, { decimals: false })} ${sign} (з ${formatMinor(totalMinor, { decimals: false })} ${sign})`}
      </div>
      <div className="split-actions">
        <button className="btn sm ghost" onClick={() => setEditing(false)}>Скасувати</button>
        <button className="btn sm primary" disabled={!valid || isLoading} onClick={() => commit(rows)}>Зберегти поділ</button>
      </div>
    </div>
  );
}
