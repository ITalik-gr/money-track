/**
 * §COMMITTED — how much of a typical month's income is already spoken for.
 *
 * The floor card beside it answers «how long would the cushion last»; this one answers «how much
 * room do I have», with the same floor divided by INCOME instead. And it answers the question the
 * floor card cannot: is that room shrinking. A floor creeping from 55% to 70% of income over half a
 * year is how a budget stops working without any single month looking bad.
 *
 * ⚠️ A percentage FIRST (the owner: «щоб ще показувало скільки відсотково … бо зараз майже завжди
 * тіки гривні»), money under it — both, never either.
 * ⚠️ No green. A share of income taken by fixed costs is never «good» on its own terms; it is
 * neutral below 70%, a warning above, red past 100% (the floor alone outruns income). DESIGN §6:
 * a neutral state is not green.
 * ⚠️ Silent without a complete month of income: «0% of nothing» is not a reading.
 */
import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { Money } from "../ui/Money.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { useGetCommittedQuery } from "../../store/api.ts";

const fmtMonth = dateFmt({ month: "short" });
const monthLabel = (ym: string) => fmtMonth.format(new Date(`${ym}-15T12:00:00Z`));
const toneOf = (share: number) => (share > 1 ? "neg" : share >= 0.7 ? "warn" : "idle");

export function CommittedCard() {
  const t = useT();
  const { data } = useGetCommittedQuery();
  if (!data || data.share == null || data.income == null || data.free == null) return null;

  const pct = Math.round(data.share * 100);
  const tone = toneOf(data.share);
  const first = data.trend[0];
  const moved = first && data.trend.length >= 2 ? pct - Math.round((first.share ?? 0) * 100) : null;
  const maxShare = Math.max(1, ...data.trend.map((p) => p.share ?? 0));

  return (
    <div className="card committed-card">
      <div className="ai-head">
        <div style={{ minWidth: 0 }}>
          <div className="ai-title">
            {t("committed.title")}
            <InfoTip>{t("committed.tip")}</InfoTip>
          </div>
          <div className="label">{t("committed.sub", { n: data.months })}</div>
        </div>
      </div>

      <div className="cm-head">
        <span className={`cm-pct ${tone}`}>{pct}%</span>
        <span className="cm-said">
          <Money minor={data.floor} decimals={false} /> {t("committed.of")} <Money minor={data.income} decimals={false} />
          {" · "}
          {data.free >= 0
            ? <>{t("committed.leftLabel")} <b><Money minor={data.free} decimals={false} /></b></>
            : <span className="neg">{t("committed.overLabel")} <b><Money minor={-data.free} decimals={false} /></b></span>}
        </span>
      </div>

      {/* One bar, two parts: what is taken and what is left, on the income's own length. A share
          past 100% fills the bar and says so in the sentence above — the bar may not overflow its
          card, the words carry the overshoot. */}
      <div className="cm-bar" aria-hidden>
        <span className={`cm-fill ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>

      {data.trend.length >= 2 && (
        <div className="cm-trend">
          <div className="cm-trend-head">
            <span className="label">{t("committed.trend")}</span>
            {moved != null && moved !== 0 && (
              <span className={`cm-moved ${moved > 0 ? "neg" : "pos"}`}>
                {t("committed.moved", { value: `${moved > 0 ? "+" : "−"}${Math.abs(moved)}`, month: monthLabel(first.ym) })}
              </span>
            )}
          </div>
          <div className="cm-cols">
            {data.trend.map((p) => {
              const s = p.share ?? 0;
              return (
                <div className="cm-col" key={p.ym} title={`${monthLabel(p.ym)} · ${Math.round(s * 100)}%`}>
                  <span className="cm-col-v">{Math.round(s * 100)}%</span>
                  <span className="cm-col-track"><i className={toneOf(s)} style={{ height: `${Math.max(4, (s / maxShare) * 100)}%` }} /></span>
                  <span className="cm-col-m">{monthLabel(p.ym)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="fl-note">{t("committed.note")}</div>
    </div>
  );
}
