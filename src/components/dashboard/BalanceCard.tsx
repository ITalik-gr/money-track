import { Link } from "react-router-dom";
import { useGetSummaryQuery } from "../../store/api.ts";
import { Money } from "../ui/Money.tsx";
import { Icon } from "../ui/Icon.tsx";
import { formatMinor } from "../../lib/format.ts";
import { baseSign } from "../../lib/currency.ts";
import { useCountUp } from "../../lib/useCountUp.ts";
import { useT } from "../../i18n/index.ts";

// Власні кошти великою sans-цифрою (гібрид, DESIGN.md §2) + швидкі дії (DeliFin R1).
export function BalanceCard() {
  const t = useT();
  const { data, isLoading } = useGetSummaryQuery();
  // §BASE-CUR: the hero is the TOTAL, converted into the reader's currency — not the hryvnia
  // bucket. Picking one currency out of the breakdown made the headline figure answer a different
  // question from the card's own label ("own funds"), and on a dollar screen it answered it in
  // the wrong unit besides. The per-currency chips below still show each bucket AS IT IS.
  const total = data?.totalUAH ?? 0;
  const others = data?.byCurrency.filter((x) => x.own !== 0) ?? [];
  // §10.4: делікатний count-up герой-суми, коли дані приходять
  const animTotal = useCountUp(total);

  return (
    <div className="card balance hero">
      <div className="bal-top">
        <span className="label">{t("bal.ownFunds")}</span>
        <Link to="/accounts" className="label">{t("link.accounts")} →</Link>
      </div>

      <div className={`bal-num num-hero ${total < 0 ? "neg" : ""}`}>
        {isLoading ? "…" : (
          <>
            {formatMinor(Math.round(animTotal), { decimals: false })}
            <span className="cur">{baseSign()}</span>
          </>
        )}
      </div>

      {/* The breakdown is shown only when it says something the hero does not: one bucket in the
          display currency IS the hero. Each chip stays in its OWN currency — that is the fact the
          hero deliberately dissolves, and repeating the total here would just say it twice. */}
      {others.length > 1 && (
        <div className="bal-chips">
          {others.map((x) => (
            <div key={x.currency_code} className="bal-chip">
              <span className="label">{t("bal.inCurrency")}</span>
              <Money minor={x.own} currency={x.currency_code} decimals={false} />
            </div>
          ))}
        </div>
      )}

      <div className="quick-actions">
        <Link to="/add" className="btn primary">
          <Icon name="add" size={17} /> {t("nav.add")}
        </Link>
        <Link to="/tx" className="btn">
          <Icon name="tx" size={17} /> {t("bal.allTx")}
        </Link>
      </div>
    </div>
  );
}
