import { Link } from "react-router-dom";
import { useGetOverviewQuery } from "../../store/api.ts";
import { formatMinor } from "../../lib/format.ts";
import { InfoTip } from "../ui/InfoTip.tsx";
import { EmptyCard } from "../ui/EmptyCard.tsx";
import { useT } from "../../i18n/index.ts";
import { baseSign } from "../../lib/currency.ts";

// §4 Пульс місяця для Головної: норма заощаджень + топ-категорії міні (календарний місяць,
// зведено в ₴). Одна вибірка overview → обидва блоки. Клік по категорії → дриль у Статистиці.
const FALLBACK = ["#1f6e4c", "#2e6be6", "#7a3e9d", "#c9871a", "#b23a2e"];

export function MonthPulse() {
  const t = useT();
  const { data } = useGetOverviewQuery({ preset: "month", currency: 980 });
  if (!data) return null;

  const income = data.summary.income;
  const spend = data.summary.spend;
  const net = income - spend;
  const rate = income > 0 ? Math.round((net / income) * 100) : null;
  const top = (data.byCategory ?? []).slice(0, 4);
  const topMax = Math.max(...top.map((c) => c.spent), 1);
  // Заголовок ЗОВНІ картки, як у сусіда по `.dash-pair` (safe-to-spend, прогноз, підписки).
  // Поки він жив усередині, половини пари мали різну анатомію: у лівої над карткою стояв
  // `.section-head`, у правої — ні, тож при `align-items: start` верхні краї карток
  // розходились рівно на висоту заголовка, і ряд читався як з'їхала верстка (скарга 2026-08-01).
  const head = (
    <div className="section-head">
      <h2>{t("mp.title")}</h2>
      <Link to="/stats" className="label group-link">{t("link.stats")} →</Link>
    </div>
  );

  // ROADMAP L3: a month with no movement still owes its half of the `.dash-pair` a card —
  // returning null left safe-to-spend stranded next to an empty column.
  if (income === 0 && spend === 0) {
    return (
      <section>
        {head}
        <EmptyCard icon="stats" title={t("empty.pulse.title")} hint={t("empty.pulse.hint")}
          to="/add" action={t("empty.pulse.action")} />
      </section>
    );
  }

  // Тон норми заощаджень: ≥20% добре, 0–20 помірно, <0 у мінусі.
  const rateTone = rate == null ? "" : rate >= 20 ? "pos" : rate < 0 ? "neg" : "warn";

  return (
    <section>
      {head}
      <div className="card pulse">
        <div className="pulse-save">
          <div className="pulse-save-main">
            <span className="label" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              {t("mp.savingsRate")}
              <InfoTip>{t("mp.info")}</InfoTip>
            </span>
            <div className={`pulse-rate num-hero ${rateTone}`}>
              {rate == null ? "—" : <>{rate > 0 ? "+" : ""}{rate}<span className="cur">%</span></>}
            </div>
          </div>
          <div className="pulse-save-detail">
            <span>{t("mp.income")} <b className="pos">{formatMinor(income, { decimals: false })} {baseSign()}</b></span>
            <span>{t("common.expenses")} <b className="neg">{formatMinor(spend, { decimals: false })} {baseSign()}</b></span>
            <span>{t("mp.saved")} <b className={net >= 0 ? "pos" : "neg"}>{net >= 0 ? "+" : "−"}{formatMinor(Math.abs(net), { decimals: false })} {baseSign()}</b></span>
          </div>
        </div>

        {top.length > 0 && (
          <div className="pulse-cats">
            <span className="label" style={{ display: "block", marginBottom: 8 }}>{t("common.topCategories")}</span>
            {top.map((c, i) => (
              <Link key={c.category_id ?? i} to={`/stats?tab=categories`} className="pulse-cat">
                <span className="pc-name"><span className="d" style={{ background: c.color ?? FALLBACK[i % FALLBACK.length] }} />{c.category_name ?? t("common.uncategorized")}</span>
                <span className="pc-track"><span style={{ width: `${(c.spent / topMax) * 100}%`, background: c.color ?? FALLBACK[i % FALLBACK.length] }} /></span>
                <span className="pc-val">{formatMinor(c.spent, { decimals: false })} {baseSign()}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
