import { Link } from "react-router-dom";
import { useGetSafeToSpendQuery } from "../../store/api.ts";
import { Money } from "../ui/Money.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { useT } from "../../i18n/index.ts";

// §4 Safe-to-spend: скільки вільно до кінця місяця = дохід − витрачено − прийдешні підписки.
// Розбивка (обов'язкові/бажані) — з вагомості §6. Клік по підписках → /subs.
export function SafeToSpend() {
  const t = useT();
  const { data, error, refetch } = useGetSafeToSpendQuery();
  /**
   * A grid child does not vanish (CLAUDE.md): this is one half of a `.dash-pair`, and returning
   * `null` on FAILURE left its neighbour alone in a row sized for two. `> :only-child` keeps the
   * layout from breaking, but the block itself disappeared with no explanation — the empty half
   * of the rule, where the documented fix only ever covered "no data yet".
   */
  if (error) {
    return (
      <section>
        <div className="section-head"><h2>{t("sts.title")}</h2></div>
        <ErrorNote error={error} what={t("sts.title")} onRetry={refetch} />
      </section>
    );
  }
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

        {/*
          §INCOME-PLAN — expected income sits BELOW the total, outside the sum, on purpose.
          The figure above is what people spend against, so an unpaid invoice must not be inside
          it: income is neither the same size nor on time, and a "free to spend" number propped up
          by money that has not arrived is the one mistake this screen must never make. Shown
          separately it answers the other real question — "is more coming before the 1st?" — which
          is exactly what makes a low `safe` early in the month readable instead of alarming.
        */}
        {(data.income_expected > 0 || data.income_overdue > 0) && (
          <div className="sts-expect">
            {data.income_expected > 0 && (
              <span className="sts-expect-line">
                {t("sts.expected")}{" "}
                <b>{data.income_estimated ? "≈" : ""}<Money minor={data.income_expected} decimals={false} /></b>
              </span>
            )}
            {/* Overdue is its own sentence, not a smaller expected: "should have arrived on the
                5th and did not" is a question for a client, while "arrives on the 25th" is just
                the calendar. Folding them together loses the only actionable one. */}
            {data.income_overdue > 0 && (
              <span className="sts-expect-line late">
                {t("sts.overdue")} <b><Money minor={data.income_overdue} decimals={false} /></b>
              </span>
            )}
          </div>
        )}
        <div className="sts-imp">
          <span className="lg"><span className="d" style={{ background: "var(--c-teal)" }} />{t("imp.essential")} <b><Money minor={data.essential} decimals={false} /></b></span>
          <span className="lg"><span className="d" style={{ background: "var(--c-ochre)" }} />{t("imp.discretionary")} <b><Money minor={data.discretionary} decimals={false} /></b></span>
        </div>
      </div>
    </section>
  );
}
