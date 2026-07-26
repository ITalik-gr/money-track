import { Link } from "react-router-dom";
import { useGetSummaryQuery } from "../../store/api.ts";
import { Money } from "../ui/Money.tsx";
import { Icon } from "../ui/Icon.tsx";
import { formatMinor, currencySign } from "../../lib/format.ts";
import { useCountUp } from "../../lib/useCountUp.ts";
import { useT } from "../../i18n/index.ts";

// Власні кошти великою sans-цифрою (гібрид, DESIGN.md §2) + швидкі дії (DeliFin R1).
export function BalanceCard() {
  const t = useT();
  const { data, isLoading } = useGetSummaryQuery();
  const uah = data?.byCurrency.find((x) => x.currency_code === 980)?.own ?? 0;
  const others = data?.byCurrency.filter((x) => x.currency_code !== 980 && x.own !== 0) ?? [];
  // §10.4: делікатний count-up герой-суми, коли дані приходять
  const animUah = useCountUp(uah);

  return (
    <div className="card balance hero">
      <div className="bal-top">
        <span className="label">{t("bal.ownFunds")}</span>
        <Link to="/accounts" className="label">{t("link.accounts")} →</Link>
      </div>

      <div className={`bal-num num-hero ${uah < 0 ? "neg" : ""}`}>
        {isLoading ? "…" : (
          <>
            {formatMinor(Math.round(animUah), { decimals: false })}
            <span className="cur">{currencySign(980)}</span>
          </>
        )}
      </div>

      {(others.length > 0 || (data && data.totalUAH !== uah)) && (
        <div className="bal-chips">
          {others.map((x) => (
            <div key={x.currency_code} className="bal-chip">
              <span className="label">{t("bal.inCurrency")}</span>
              <Money minor={x.own} currency={x.currency_code} decimals={false} />
            </div>
          ))}
          {data && data.totalUAH !== uah && (
            <div className="bal-chip">
              <span className="label">{t("bal.totalUah")}</span>
              <Money minor={data.totalUAH} decimals={false} />
            </div>
          )}
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
