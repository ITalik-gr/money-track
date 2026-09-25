/**
 * §INCOME-RHYTHM — how income ARRIVES: the longest wait, the current wait, and in how many months
 * it covered the recurring floor. For irregular (ФОП) income these three decide a month more than
 * the total does. Silent with under two complete months — a rhythm needs a second beat.
 *
 * ⚠️ The current wait is warned only when it is already LONGER than the longest one before it —
 * «12 days since the last payment» is ordinary for a monthly salary and must not read as an alarm.
 */
import { useT } from "../../i18n/index.ts";
import { InfoTip } from "../ui/InfoTip.tsx";
import { useGetIncomeRhythmQuery } from "../../store/api.ts";

export function IncomeRhythmCard() {
  const t = useT();
  const { data } = useGetIncomeRhythmQuery();
  if (!data || data.months < 2 || data.longest_gap_days == null) return null;
  const waitingLong = data.days_since_last != null && data.days_since_last >= data.longest_gap_days && data.days_since_last > 35;
  return (
    <div className="card rhythm-card">
      <div className="ai-title">
        {t("rhythm.title")}
        <InfoTip>{t("rhythm.tip")}</InfoTip>
      </div>
      <div className="rh-grid">
        <div className="rh-cell">
          <span className="label">{t("rhythm.longest")}</span>
          <b>{t("rhythm.days", { n: data.longest_gap_days })}</b>
        </div>
        {data.days_since_last != null && (
          <div className="rh-cell">
            <span className="label">{t("rhythm.since")}</span>
            <b className={waitingLong ? "warn" : ""}>{t("rhythm.days", { n: data.days_since_last })}</b>
          </div>
        )}
        {data.covered_floor != null && (
          <div className="rh-cell">
            <span className="label">{t("rhythm.covered")}</span>
            <b className={data.covered_floor < data.months ? "warn" : ""}>{t("rhythm.ofMonths", { n: data.covered_floor, of: data.months })}</b>
          </div>
        )}
        {data.cv_pct != null && (
          <div className="rh-cell">
            <span className="label">{t("rhythm.spread")}</span>
            <b>{data.cv_pct}%</b>
          </div>
        )}
      </div>
    </div>
  );
}
