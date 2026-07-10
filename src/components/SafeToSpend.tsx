import { Link } from "react-router-dom";
import { useGetSafeToSpendQuery } from "../store/api.ts";
import { Money } from "./Money.tsx";

// §4 Safe-to-spend: скільки вільно до кінця місяця = дохід − витрачено − прийдешні підписки.
// Розбивка (обов'язкові/бажані) — з вагомості §6. Клік по підписках → /subs.
export function SafeToSpend() {
  const { data } = useGetSafeToSpendQuery();
  if (!data) return null;
  const neg = data.safe < 0;

  return (
    <section>
      <div className="section-head">
        <h2>Вільно до кінця місяця</h2>
        <Link to="/plan" className="label group-link">бюджети →</Link>
      </div>
      <div className={`card sts-card ${neg ? "neg" : ""}`}>
        <div className="sts-hero">
          <span className="sts-label">{neg ? "перевитрата" : "можна витратити"}</span>
          <span className="sts-num"><Money minor={Math.abs(data.safe)} decimals={false} /></span>
          <span className="sts-sub">дохід − витрати − прийдешні підписки за цей місяць</span>
        </div>
        <div className="sts-break">
          <div className="sts-line"><span>Дохід</span><b className="pos"><Money minor={data.income} decimals={false} /></b></div>
          <div className="sts-line"><span>− Витрачено</span><b><Money minor={data.spend} decimals={false} /></b></div>
          <div className="sts-line"><span>− Підписки (залишок)</span><b><Money minor={data.subs_remaining} decimals={false} /></b></div>
          <div className="sts-line total"><span>= Вільно</span><b className={neg ? "neg" : "pos"}><Money minor={data.safe} decimals={false} signed /></b></div>
        </div>
        <div className="sts-imp">
          <span className="lg"><span className="d" style={{ background: "#127c86" }} />обов'язкові <b><Money minor={data.essential} decimals={false} /></b></span>
          <span className="lg"><span className="d" style={{ background: "#c9871a" }} />бажані/необов. <b><Money minor={data.discretionary} decimals={false} /></b></span>
        </div>
      </div>
    </section>
  );
}
