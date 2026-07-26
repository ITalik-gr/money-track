import { Link } from "react-router-dom";
import { useGetSafeToSpendQuery } from "../../store/api.ts";
import { Money } from "../ui/Money.tsx";
import { useT } from "../../i18n/index.ts";

// §4 Safe-to-spend: скільки вільно до кінця місяця = дохід − витрачено − прийдешні підписки.
// Розбивка (обов'язкові/бажані) — з вагомості §6. Клік по підписках → /subs.
export function SafeToSpend() {
  const t = useT();
  const { data } = useGetSafeToSpendQuery();
  if (!data) return null;
  const neg = data.safe < 0;

  return (
    <section>
      <div className="section-head">
        <h2>{t("sts.title")}</h2>
        <Link to="/plan" className="label group-link">{t("link.budgets")} →</Link>
      </div>
      <div className={`card sts-card ${neg ? "neg" : ""}`}>
        <div className="sts-hero">
          <span className="sts-label">{neg ? t("sts.over") : t("sts.canSpend")}</span>
          <span className="sts-num"><Money minor={Math.abs(data.safe)} decimals={false} /></span>
          <span className="sts-sub">{t("sts.formula")}</span>
        </div>
        <div className="sts-break">
          <div className="sts-line"><span>{t("common.income")}</span><b className="pos"><Money minor={data.income} decimals={false} /></b></div>
          <div className="sts-line"><span>{t("sts.minusSpent")}</span><b><Money minor={data.spend} decimals={false} /></b></div>
          <div className="sts-line"><span>{t("sts.minusSubs")}</span><b><Money minor={data.subs_remaining} decimals={false} /></b></div>
          <div className="sts-line total"><span>{t("sts.eqFree")}</span><b className={neg ? "neg" : "pos"}><Money minor={data.safe} decimals={false} signed /></b></div>
        </div>
        <div className="sts-imp">
          <span className="lg"><span className="d" style={{ background: "var(--c-teal)" }} />{t("imp.essential")} <b><Money minor={data.essential} decimals={false} /></b></span>
          <span className="lg"><span className="d" style={{ background: "var(--c-ochre)" }} />{t("imp.discretionary")} <b><Money minor={data.discretionary} decimals={false} /></b></span>
        </div>
      </div>
    </section>
  );
}
