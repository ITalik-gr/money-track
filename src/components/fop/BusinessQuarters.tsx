import { useT } from "../../i18n/index.ts";
import { Money } from "../ui/Money.tsx";
import { HRYVNIA } from "../../../shared/currency.ts";
import type { BusinessOverview } from "../../store/api.ts";

/**
 * The business by quarter: earned, taxed, spent, kept.
 *
 * ⚠️ The column that earns its place is `fixed` — the part of the tax that does NOT move with
 * income (ЄСВ, and the flat ЄП/ВЗ of groups 1–2). At 20 000 ₴ a quarter the percentage taxes are
 * 1 200 ₴ and the contribution is 5 707 ₴: the effective rate is 34%, not the 5% printed on every
 * rates table. A single blended figure would hide exactly the thing a quiet quarter needs to say.
 *
 * ⚠️ Compared with the SAME quarter a year earlier, never with the previous one. Work that has a
 * season would make every January read as a collapse, and the app would be alarming about the
 * calendar.
 */
export function BusinessQuarters({ data }: { data: BusinessOverview }) {
  const t = useT();
  const current = data.quarters.at(-1);
  const peak = Math.max(1, ...data.quarters.map((q) => q.income));

  return (
    <div className="card">
      <div className="section-head">
        <h3>{t("fop.business")}</h3>
        {data.year_ago && current && (
          <span className="fop-yoy">
            {t("fop.vsYearAgo", { label: data.year_ago.label })}{" "}
            <Money minor={current.income - data.year_ago.income} currency={HRYVNIA} decimals={false} signed />
          </span>
        )}
      </div>

      <div className="fop-qgrid">
        {data.quarters.map((q) => (
          <div key={q.label} className="fop-q">
            <div className="fop-q-label">{q.label}</div>
            {/* The bar is proportional to the biggest quarter shown, not to the limit: this block
                answers «how did the quarters compare», and the ceiling has its own gauge above. */}
            <div className="fop-q-bar"><div className="fop-q-fill" style={{ height: `${(q.income / peak) * 100}%` }} /></div>
            <div className="fop-q-income"><Money minor={q.income} currency={HRYVNIA} decimals={false} /></div>
            <div className="fop-q-rows">
              <span className="fop-q-row"><i>{t("fop.tax")}</i><Money minor={q.tax} currency={HRYVNIA} decimals={false} /></span>
              <span className="fop-q-row"><i>{t("fop.fixedPart")}</i><Money minor={q.fixed} currency={HRYVNIA} decimals={false} /></span>
              <span className="fop-q-row"><i>{t("fop.costs")}</i><Money minor={q.expenses} currency={HRYVNIA} decimals={false} /></span>
              <span className="fop-q-row net"><i>{t("fop.net")}</i><Money minor={q.net} currency={HRYVNIA} decimals={false} signed /></span>
            </div>
            <div className="fop-q-rate">
              {q.effective_pct == null
                ? t("fop.noIncome")
                : t("fop.effective", { pct: String(q.effective_pct) })}
            </div>
          </div>
        ))}
      </div>

      {/* Stated once, plainly. Somebody who sees «робочі витрати» beside a tax figure will
          reasonably assume the first lowers the second — on the single tax it does not, and
          acting on that assumption is what costs money (docs/TAX.md §2). */}
      <p className="fop-note">{t("fop.costsNote")}</p>
    </div>
  );
}
