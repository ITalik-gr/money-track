import { useGetReceiptItemsQuery } from "../store/api.ts";
import { formatMinor } from "../lib/format.ts";
import { HoverTip } from "./HoverTip.tsx";

// Аналітика позицій чека: топ товарів за сумою (з OCR-чеків) за період. Ховається, якщо чеків нема.
export function ReceiptItems({ from, to, sign }: { from: number; to: number; sign: string }) {
  const { data } = useGetReceiptItemsQuery({ from, to, limit: 12 });
  if (!data || data.receipts === 0 || data.items.length === 0) return null;

  const max = Math.max(...data.items.map((i) => i.total), 1);
  return (
    <section>
      <div className="section-head">
        <h2>Товари з чеків</h2>
        <HoverTip content={<>Позиції з розпізнаних чеків (OCR). Топ товарів за сумою за період. Сума — за рядок чека; кількість — сумарна.</>}>
          <span className="label">{data.receipts} чек{data.receipts % 10 === 1 && data.receipts % 100 !== 11 ? "" : "и/ів"} · що це?</span>
        </HoverTip>
      </div>
      <div className="card flush"><div className="catbars">
        {data.items.map((it, i) => {
          const p = (it.total / max) * 100;
          return (
            <div key={i} className="catbar">
              <span className="cb-name" title={it.name}>{it.name}</span>
              <span className="cb-track"><span className="cb-fill" style={{ width: `${p}%`, background: "var(--c-teal, #127c86)" }} /></span>
              <span className="cb-val">{formatMinor(it.total, { decimals: false })} {sign}</span>
              <span className="cb-pct">×{it.qty % 1 === 0 ? it.qty : it.qty.toFixed(1)}</span>
            </div>
          );
        })}
      </div></div>
    </section>
  );
}
