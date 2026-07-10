import { useGetPriceDriftQuery } from "../store/api.ts";
import { formatMinor } from "../lib/format.ts";
import { HoverTip } from "./HoverTip.tsx";

// §E4: дрейф цін / персональна інфляція — як змінилась юніт-ціна позицій із чеків у часі.
// Ховається, якщо ще нема достатньо історії чеків. Індекс кошика — медіана змін.
export function PriceDrift() {
  const { data } = useGetPriceDriftQuery();
  if (!data || data.tracked === 0) return null;
  const basket = data.basket_change_pct;

  return (
    <section>
      <div className="section-head">
        <h2>Дрейф цін</h2>
        <HoverTip content={<>Як змінилась ціна за одиницю товару в твоїх чеках (рання половина покупок проти пізньої). Індекс кошика — медіана змін по всіх відстежених позиціях за ~6 міс. Твоя персональна інфляція.</>}>
          <span className="label">персональна інфляція · що це?</span>
        </HoverTip>
      </div>
      <div className="card" style={{ padding: 16 }}>
        {basket != null && (
          <div className="drift-index">
            <span className="label">Індекс кошика (~6 міс)</span>
            <span className={`drift-index-val num-hero ${basket > 0 ? "neg" : basket < 0 ? "pos" : ""}`}>
              {basket > 0 ? "+" : ""}{basket}%
            </span>
            <span className="muted" style={{ fontSize: 12 }}>по {data.tracked} позиц.</span>
          </div>
        )}
        {data.items.length > 0 ? (
          <div className="drift-list">
            {data.items.map((it, i) => (
              <div key={i} className="drift-row">
                <span className="drift-name" title={it.name}>{it.name}</span>
                <span className="drift-units num-mono">
                  {formatMinor(it.first_unit, { decimals: false })} → {formatMinor(it.last_unit, { decimals: false })} ₴
                </span>
                <span className={`cmp-delta ${it.change_pct > 0 ? "up" : "down"}`}>
                  {it.change_pct > 0 ? "+" : ""}{it.change_pct}%
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ margin: basket != null ? "10px 0 0" : 0, fontSize: 13 }}>
            Помітних змін цін поки нема — ціни стабільні.
          </p>
        )}
      </div>
    </section>
  );
}
