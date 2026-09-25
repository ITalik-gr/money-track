import { useMemo } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useT } from "../i18n/index.ts";
import {
  useGetOverviewQuery, useGetMonthlyHistoryQuery, useGetSpendProfileQuery,
  useGetMomentumQuery, useGetPriceDriftQuery,
} from "../store/api.ts";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";
import { SkeletonRows } from "../components/ui/Skeleton.tsx";
import { EmptyCard } from "../components/ui/EmptyCard.tsx";
import { Money } from "../components/ui/Money.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { monthShort } from "../lib/format.ts";
import { localMidnight, localParts, nowUnix } from "../../shared/time.ts";

/**
 * `/wrapped` — the year, as a screen somebody would want to show another person.
 *
 * ⚠️ NO NEW MATHEMATICS. Every figure here is read from an endpoint that already existed and is
 * already pinned by the golden files: the year's totals (`/analytics/overview`), the most
 * expensive month (`/analytics/monthly-history`), the merchant of the year (the same overview's
 * ranking), the category on the longest run (§MOMENTUM), the quiet days (§SPEND-PROFILE) and the
 * prices that moved (§PRICE-STEPS on receipt items). That is the roadmap card's own constraint,
 * and it is the right one: a year-in-review is the LAST place to introduce a number nobody has
 * checked, because it is the one screen that gets screenshotted and believed.
 *
 * ⚠️ NO BALANCES, deliberately. A report about a year is not a statement: what somebody shares
 * says what they spent and where, never how much they have. Nothing on this page reads an account.
 *
 * ⚠️ A thin year must look DELIBERATE. Each slide renders only when its own figure exists, and a
 * year with nothing in it says so in one card instead of printing a grid of «—». The test the
 * roadmap set: a full year gives a report with no dashes, and a fresh account explains why it has
 * none yet.
 */
export function Wrapped() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const thisYear = localParts(nowUnix()).y;
  const yParam = Number(params.get("year"));
  const year = Number.isInteger(yParam) && yParam >= 2000 && yParam <= thisYear ? yParam : thisYear;

  // Kyiv year edges, like every other period in this app: a UTC (or browser-zone) edge would pull
  // hours of the neighbouring year into the window (§APP_TZ).
  const bounds = useMemo(() => ({
    from: localMidnight(year, 1, 1),
    to: Math.min(nowUnix(), localMidnight(year + 1, 1, 1)),
  }), [year]);

  const { data, isLoading, error, refetch } = useGetOverviewQuery(
    { from: bounds.from, to: bounds.to, bucket: "month", currency: null },
  );
  // 18 months, so the most expensive month of LAST year is still reachable from this page.
  const history = useGetMonthlyHistoryQuery({ months: 18 });
  const profile = useGetSpendProfileQuery(bounds);
  const momentum = useGetMomentumQuery();
  const drift = useGetPriceDriftQuery();
  /**
   * ⚠️ The secondary slides fail QUIETLY by construction — each renders only when its own figure
   * exists — and «rendered nothing» is indistinguishable from «asked and it broke». §Обробка
   * помилок is explicit that a page reading `data?.x` must have an error branch, because an empty
   * screen and a failed one have to look different. One line at the foot rather than four
   * `ErrorNote`s: the report is still readable without any one slide, so the honest statement is
   * «part of this did not load», with a way to try again.
   */
  const partial = [history, profile, momentum, drift].filter((q) => q.error);

  if (isLoading) return <SkeletonRows n={6} />;
  if (error) return <ErrorNote error={error} what={t("wr.title")} onRetry={refetch} />;

  const s = data?.summary;
  const h = history.data, prof = profile.data, mom = momentum.data, dr = drift.data;
  const net = (s?.income ?? 0) - (s?.spend ?? 0);
  // The months of THIS year only — `monthly-history` answers with a rolling window.
  const months = (h?.months ?? []).filter((m) => m.month.startsWith(String(year)));
  const peak = months.reduce<typeof months[number] | null>(
    (best, m) => (!best || m.spend > best.spend ? m : best), null,
  );
  const topMerchant = data?.byMerchant?.[0] ?? null;
  const topCategory = data?.byCategory?.[0] ?? null;
  // The longest UPWARD run, which is the §MOMENTUM row a person would actually recognise.
  const rising = (mom?.rows ?? [])
    .filter((r) => r.direction === "up")
    .sort((a, b) => b.run - a.run || b.change - a.change)[0] ?? null;
  const risen = (dr?.items ?? []).filter((i) => i.change_pct > 0).slice(0, 3);

  const empty = !s || s.n === 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("wr.title", { year: String(year) })}</div>
          <div className="sub">{t("wr.sub")}</div>
        </div>
        <div className="page-head-actions">
          <button className="pill-toggle" disabled={year <= 2000}
            onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.set("year", String(year - 1)); return n; }, { replace: true })}>
            <Icon name="chevron" size={14} />{year - 1}
          </button>
          {year < thisYear && (
            <button className="pill-toggle" onClick={() => setParams((p) => {
              const n = new URLSearchParams(p); n.set("year", String(year + 1)); return n;
            }, { replace: true })}>{year + 1}<Icon name="chevron" size={14} /></button>
          )}
        </div>
      </div>

      {empty ? (
        // The fresh-account answer: say WHY there is no report, and where the year comes from.
        <EmptyCard icon="chart" title={t("wr.emptyTitle", { year: String(year) })} hint={t("wr.emptyHint")} />
      ) : (
        <div className="wrapped">
          <div className="card wr-hero">
            <div className="wr-label">{t("wr.totals")}</div>
            <div className="wr-grid">
              <div className="wr-cell">
                <span className="wr-cell-label">{t("wr.income")}</span>
                <span className="wr-cell-val pos"><Money minor={s!.income} decimals={false} /></span>
              </div>
              <div className="wr-cell">
                <span className="wr-cell-label">{t("wr.spend")}</span>
                <span className="wr-cell-val"><Money minor={s!.spend} decimals={false} /></span>
              </div>
              <div className="wr-cell">
                <span className="wr-cell-label">{t("wr.net")}</span>
                <span className={`wr-cell-val ${net >= 0 ? "pos" : "neg"}`}>
                  <Money minor={net} decimals={false} signed />
                </span>
              </div>
              {/* §savingsRatePct — the server's figure, never a sixth spelling of it. */}
              {s!.savings_rate_pct != null && (
                <div className="wr-cell">
                  <span className="wr-cell-label">{t("wr.rate")}</span>
                  <span className="wr-cell-val">{s!.savings_rate_pct}%</span>
                </div>
              )}
              <div className="wr-cell">
                <span className="wr-cell-label">{t("wr.ops")}</span>
                <span className="wr-cell-val">{s!.n}</span>
              </div>
            </div>
          </div>

          {peak && (
            <div className="card wr-slide">
              <div className="wr-label">{t("wr.peakMonth")}</div>
              {/* `monthShort` takes a 0-based index, and `peak.month` is «YYYY-MM» — the slice is
                  the same one `MonthlyHistory` does, and getting it wrong would print January. */}
              <div className="wr-big">{monthShort(Number(peak.month.slice(5)) - 1)}</div>
              <div className="wr-note"><Money minor={peak.spend} decimals={false} /></div>
            </div>
          )}

          {topMerchant && (
            <div className="card wr-slide">
              <div className="wr-label">{t("wr.merchant")}</div>
              <div className="wr-big">{topMerchant.merchant}</div>
              <div className="wr-note">
                {t("wr.merchantNote", { n: String(topMerchant.n) })} · <Money minor={topMerchant.spent} decimals={false} />
              </div>
            </div>
          )}

          {topCategory?.category_name && (
            <div className="card wr-slide">
              <div className="wr-label">{t("wr.category")}</div>
              <div className="wr-big">{topCategory.category_name}</div>
              <div className="wr-note"><Money minor={topCategory.spent} decimals={false} /></div>
            </div>
          )}

          {rising && rising.run >= 2 && (
            <div className="card wr-slide">
              <div className="wr-label">{t("wr.rising")}</div>
              <div className="wr-big">{rising.name}</div>
              {/* §MOMENTUM states a RUN of complete months, so the sentence names the run — a
                  percentage alone would not say that it kept happening. */}
              <div className="wr-note">{t("wr.risingNote", { n: String(rising.run) })}</div>
            </div>
          )}

          {prof && prof.quiet_days.days > 0 && (
            <div className="card wr-slide">
              <div className="wr-label">{t("wr.quiet")}</div>
              <div className="wr-big">{prof.quiet_days.quiet}</div>
              <div className="wr-note">
                {t("wr.quietNote", { days: String(prof.quiet_days.days) })}
                {prof.quiet_days.longest_streak > 1 &&
                  ` · ${t("wr.quietStreak", { n: String(prof.quiet_days.longest_streak) })}`}
              </div>
            </div>
          )}

          {risen.length > 0 && (
            <div className="card wr-slide wr-wide">
              <div className="wr-label">{t("wr.prices")}</div>
              <div className="fop-ranks">
                {risen.map((i) => (
                  <div key={i.name} className="fop-rank">
                    <span className="fop-rank-name">{i.name}</span>
                    <span className="fop-rank-n">+{Math.round(i.change_pct)}%</span>
                    <Money minor={i.last_unit} decimals={false} className="fop-rank-sum" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {partial.length > 0 && (
            <p className="wr-foot wr-partial">
              {t("wr.partial")}{" "}
              <button className="btn ghost sm" onClick={() => partial.forEach((q) => void q.refetch())}>
                {t("common.retry")}
              </button>
            </p>
          )}
          <p className="wr-foot">{t("wr.foot")} <Link to="/stats">{t("nav.stats")}</Link></p>
        </div>
      )}
    </>
  );
}
