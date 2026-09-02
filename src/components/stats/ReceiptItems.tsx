import { useGetReceiptItemsQuery } from "../../store/api.ts";
import { formatMinor } from "../../lib/format.ts";
import { baseSign } from "../../lib/currency.ts";
import { HoverTip } from "../ui/HoverTip.tsx";
import { useT } from "../../i18n/index.ts";

// Аналітика позицій чека: топ товарів за сумою (з OCR-чеків) за період. Ховається, якщо чеків нема.
export function ReceiptItems({ from, to }: { from: number; to: number }) {
  // §SIGN-FOLLOWS-DATA: receipt lines are rolled up into the reader's base and the endpoint takes
  // no `currency`, so the page's currency filter must not sign them.
  const sign = baseSign();
  const t = useT();
  const { data } = useGetReceiptItemsQuery({ from, to, limit: 12 });
  if (!data || data.receipts === 0 || data.items.length === 0) return null;

  const max = Math.max(...data.items.map((i) => i.total), 1);
  // Українська форма "чек/чеки/чеків" спрощена до два-словної пари (однина/множина);
  // англійська — звичайне s.
  const receiptWord = data.receipts % 10 === 1 && data.receipts % 100 !== 11 ? t("ri.receiptWord") : t("ri.receiptWordPlural");
  return (
    <section>
      <div className="section-head">
        <h2>{t("ri.title")}</h2>
        <HoverTip content={<>{t("ri.tip")}</>}>
          <span className="label">{data.receipts} {receiptWord} · {t("common.whatIsThis")}</span>
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
