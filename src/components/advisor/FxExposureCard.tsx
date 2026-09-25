/**
 * §FX-EXPOSURE — which currencies the money and the spending sit in, and a ±10% what-if.
 *
 * Silent for a single-currency ledger. The what-if is worded as one («якщо … подорожчають на 10%»),
 * never as a forecast. Both effects are shown because they pull in opposite directions for someone
 * who SAVES in a foreign currency and PAYS in it too — seeing only one would be half the answer.
 */
import { useT } from "../../i18n/index.ts";
import { Money } from "../ui/Money.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { useGetFxExposureQuery } from "../../store/api.ts";
import { currencySign } from "../../../shared/currency.ts";
import { wholePcts } from "../../../shared/pct.ts";

function Split({ label, rows }: { label: string; rows: { currency_code: number; share: number }[] }) {
  const pcts = wholePcts(rows.map((r) => r.share));
  return (
    <div className="fx-split">
      <span className="label">{label}</span>
      <span className="fx-chips">
        {rows.map((r, i) => (
          <span key={r.currency_code} className="fx-chip">{currencySign(r.currency_code)} <b>{pcts[i]}%</b></span>
        ))}
      </span>
    </div>
  );
}

export function FxExposureCard() {
  const t = useT();
  const { data } = useGetFxExposureQuery();
  if (!data || (data.assets_delta === 0 && data.spend_delta_monthly === 0)) return null;
  const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");
  return (
    <div className="card fx-card">
      <div className="ai-title">
        {t("fxexp.title")}
        <InfoTip>{t("fxexp.tip")}</InfoTip>
      </div>
      <p className="fx-said">{t("fxexp.whatIf", { pct: data.move_pct, base: currencySign(data.base_currency) })}</p>
      <div className="fx-effects">
        <span>{t("fxexp.capital")} <b className={data.assets_delta >= 0 ? "pos" : "neg"}>{sign(data.assets_delta)}<Money minor={Math.abs(data.assets_delta)} decimals={false} /></b></span>
        <span>{t("fxexp.spending")} <b className={data.spend_delta_monthly > 0 ? "neg" : "pos"}>{sign(data.spend_delta_monthly)}<Money minor={Math.abs(data.spend_delta_monthly)} decimals={false} /></b>{t("stack.perMonthSuffix")}</span>
      </div>
      {data.assets.length > 1 && <Split label={t("fxexp.assetsIn")} rows={data.assets} />}
      {data.spend.length > 1 && <Split label={t("fxexp.spendIn")} rows={data.spend} />}
    </div>
  );
}
