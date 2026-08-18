import { useGetPriceDriftQuery } from "../../store/api.ts";
import { formatMinor } from "../../lib/format.ts";
import { HoverTip } from "../ui/HoverTip.tsx";
import { useT } from "../../i18n/index.ts";
import { baseSign } from "../../lib/currency.ts";

// §E4: дрейф цін / персональна інфляція — як змінилась юніт-ціна позицій із чеків у часі.
// Ховається, якщо ще нема достатньо історії чеків. Індекс кошика — медіана змін.
export function PriceDrift() {
  const t = useT();
  const { data } = useGetPriceDriftQuery();
  if (!data || data.tracked === 0) return null;
  const basket = data.basket_change_pct;

  return (
    <section>
      <div className="section-head">
        <h2>{t("pd.title")}</h2>
        <HoverTip content={<>{t("pd.tip")}</>}>
          <span className="label">{t("pd.subtitle")}</span>
        </HoverTip>
      </div>
      <div className="card" style={{ padding: 16 }}>
        {basket != null && (
          <div className="drift-index">
            <span className="label">{t("pd.basketIndexLabel")}</span>
            <span className={`drift-index-val num-hero ${basket > 0 ? "neg" : basket < 0 ? "pos" : ""}`}>
              {basket > 0 ? "+" : ""}{basket}%
            </span>
            <span className="muted" style={{ fontSize: 12 }}>{t("pd.trackedCount", { n: data.tracked })}</span>
          </div>
        )}
        {data.items.length > 0 ? (
          <div className="drift-list">
            {data.items.map((it, i) => (
              <div key={i} className="drift-row">
                <span className="drift-name" title={it.name}>{it.name}</span>
                <span className="drift-units num-mono">
                  {formatMinor(it.first_unit, { decimals: false })} → {formatMinor(it.last_unit, { decimals: false })} {baseSign()}
                </span>
                <span className={`cmp-delta ${it.change_pct > 0 ? "up" : "down"}`}>
                  {it.change_pct > 0 ? "+" : ""}{it.change_pct}%
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ margin: basket != null ? "10px 0 0" : 0, fontSize: 13 }}>
            {t("pd.noChanges")}
          </p>
        )}
      </div>
    </section>
  );
}
