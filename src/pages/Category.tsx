import { Link, useParams } from "react-router-dom";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Y_AXIS, Y_AXIS_LEFT_MARGIN } from "../lib/chart.ts";
import { dateFmt, numFmt } from "../i18n/locale.ts";
import { useT } from "../i18n/index.ts";
import { useGetCategoryOverviewQuery, useGetCategoryDrillQuery } from "../store/api.ts";
import { Money } from "../components/ui/Money.tsx";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";
import { InfoTip } from "../components/ui/InfoTip.tsx";
import { formatMinor, startOfMonthUnix } from "../lib/format.ts";
import { CHART_ANIM } from "../lib/motion.ts";

/**
 * §CATEGORY-PAGE — one category, linkable.
 *
 * The drill panel inside the Stats tab already answered "what is in this category", but it could
 * not be linked, bookmarked or reached from a budget — so the app's PRIMARY axis was the one thing
 * you could not open. (You could open a merchant.) This page is that permalink, plus the three
 * things a page needs and a drill panel does not: the canonical monthly level, a twelve-month
 * trend, and the envelope.
 *
 * Every number is server-computed canon — the level from `categoryMonthlyLevels`, the envelope
 * from `budgetStatus`, the trend and the split from `STATS_JOINS`. Recomputing any of them here
 * would be how this screen ends up disagreeing with the donut it was opened from.
 */
const fmt0 = numFmt({ maximumFractionDigits: 0 });
const monthShort = dateFmt({ month: "short" });
const monthLabel = (m: string) => {
  // The month comes from an explicit `YYYY-MM` key, never from a timestamp: formatting a period
  // boundary in the local zone puts the end of June into July (CLAUDE.md, "month of a chart").
  const [y, mm] = m.split("-");
  return monthShort.format(new Date(Number(y), Number(mm) - 1, 1));
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CTooltip(props: any) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{p.label}</div>
      <div className="r"><span className="d" style={{ background: "var(--accent)" }} />{fmt0.format(p.spent)} ₴</div>
    </div>
  );
}

export function Category() {
  const t = useT();
  const id = Number(useParams().id);
  const from = startOfMonthUnix();
  const to = Math.floor(Date.now() / 1000);

  const { data, isError, error, refetch } = useGetCategoryOverviewQuery({ id, from, to });
  const { data: drill } = useGetCategoryDrillQuery({ category: id, from, to });

  if (isError) return <ErrorNote error={error} what={t("nav.categories")} onRetry={refetch} />;
  if (!data) return null;

  const chart = data.trend.map((m) => ({ ...m, label: monthLabel(m.month), spent: Math.round(m.spent / 100) }));
  const total = data.recurring + data.oneoff;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">
            <span className="d cat-page-dot" style={{ background: data.color ?? "var(--muted)" }} />
            {data.name}
          </div>
          <div className="sub">{t(`imp.${data.importance}` as "imp.essential")}</div>
        </div>
        <div className="page-head-actions">
          <Link className="btn ghost" to="/stats">{t("cat.backToStats")}</Link>
        </div>
      </div>

      <div className="cat-page-stats">
        {/* The level FIRST: it is the answer to "how much does this cost me", which is the reason
            anyone opens a category. The period total is secondary — it depends on today's date. */}
        <div className="card merchant-stat">
          <div className="label">
            {t("cat.levelLabel")}
            <InfoTip>{data.level?.fixed ? t("cat.levelFixed") : t("cat.levelVariable")}</InfoTip>
          </div>
          <div className="merchant-stat-v num-hero">
            {data.level ? <Money minor={data.level.level} decimals={false} /> : "—"}
          </div>
          {data.level && (
            <div className="merchant-stat-sub">{t("cat.levelMonths", { n: data.level.active_months })}</div>
          )}
        </div>
        <div className="card merchant-stat">
          <div className="label">{t("cat.periodSpent")}</div>
          <div className="merchant-stat-v num-hero"><Money minor={total} decimals={false} /></div>
          {/* §E1: the split is the useful half — a big month made of one purchase means something
              different from the same month made of forty. */}
          {total > 0 && (
            <div className="merchant-stat-sub">
              {t("cat.recurringShare", { pct: Math.round((data.recurring / total) * 100) })}
            </div>
          )}
        </div>
        {data.budget && (
          <div className="card merchant-stat">
            <div className="label">{t("cat.budgetLabel")}</div>
            <div className="merchant-stat-v num-hero">
              <Money minor={data.budget.spent} decimals={false} /> / <Money minor={data.budget.amount} decimals={false} />
            </div>
            {/* The projection only when it says something the pair above does not — see EnvelopeGrid
                for why a lump carries no forecast worth showing. */}
            {!data.budget.lumpy && data.budget.projected > data.budget.amount && (
              <div className="merchant-stat-sub neg">
                {t("cat.budgetProjected", { pct: Math.round((data.budget.projected / data.budget.amount) * 100) })}
              </div>
            )}
          </div>
        )}
      </div>

      {/*
        §BUDGET-MEMORY — the question a budget could never answer before: not "how am I doing right
        now" but "am I getting better at this". The strip is deliberately NOT derived from the
        12-month trend above it: that is what was spent, while staying inside an envelope also
        depends on the limit in force at the time, and only these rows remember it.

        Rendered whenever the category HAS an envelope, empty state included — a section that
        appears out of nowhere in a month's time is a feature nobody knows to wait for.
      */}
      {data.budget && (
        <section>
          <div className="section-head">
            <h2>{t("cat.budgetHistory")}</h2>
            <span className="label">{t("cat.budgetHistoryHint")}</span>
          </div>
          <div className="card">
            {data.budget_history.length === 0
              ? <p className="label" style={{ margin: 0 }}>{t("cat.budgetHistoryEmpty")}</p>
              : (
                <ul className="bh-list">
                  {data.budget_history.map((m) => {
                    // The limit can be zero for a month the envelope carried no allowance into
                    // (a full overspend consumed it). Dividing by it would print Infinity%.
                    const ratio = m.limit > 0 ? m.spent / m.limit : (m.spent > 0 ? 1.5 : 0);
                    const over = m.spent > m.limit;
                    return (
                      <li key={m.month} className={`bh-row ${over ? "over" : "ok"}`}>
                        <span className="bh-month">{monthLabel(m.month)}</span>
                        <span className="bh-bar">
                          <i style={{ transform: `scaleX(${Math.min(ratio, 1)})` }} />
                          {/* Overspend gets its OWN mark past the end of the track rather than a
                              longer bar: a bar that can exceed its container stops being readable
                              as a proportion, which is the only thing this row is for. */}
                          {over && <b />}
                        </span>
                        <span className="bh-num">
                          <Money minor={m.spent} decimals={false} />
                          <span className="bh-of"> / <Money minor={m.limit} decimals={false} /></span>
                        </span>
                        <span className={`bh-verdict ${over ? "neg" : ""}`}>
                          {over ? t("cat.monthOver") : t("cat.monthWithin")}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
          </div>
        </section>
      )}

      <section>
        <div className="section-head"><h2>{t("cat.trendTitle")}</h2></div>
        <div className="card chart-card">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chart} margin={{ left: Y_AXIS_LEFT_MARGIN, top: 8, right: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
              {/* Width auto: a hard-coded axis width clips the label the moment an amount gains a
                  digit, and a clipped number is indistinguishable from a real one. */}
              <YAxis {...Y_AXIS} tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
              <Tooltip content={<CTooltip />} cursor={{ fill: "var(--surface-2)" }} />
              <Bar dataKey="spent" fill={data.color ?? "var(--accent)"} radius={[4, 4, 0, 0]} {...CHART_ANIM} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {data.children.length > 0 && (
        <section>
          <div className="section-head">
            <h2>{t("cat.childrenTitle")}</h2>
            <span className="label">{t("cat.childrenSub")}</span>
          </div>
          <div className="cat-page-children">
            {data.children.map((ch) => (
              <Link key={ch.id} className="cat-chip" to={`/categories/${ch.id}`}>
                <span className="d" style={{ background: ch.color ?? "var(--muted)" }} />{ch.name}
              </Link>
            ))}
          </div>
        </section>
      )}

      {!!drill?.merchants.length && (
        <section>
          <div className="section-head"><h2>{t("cat.merchantsTitle")}</h2></div>
          <div className="card">
            <ul className="cat-merch-list">
              {drill.merchants.slice(0, 12).map((m) => (
                <li key={m.merchant}>
                  <Link className="cat-merch-name" to={`/merchant/${encodeURIComponent(m.merchant)}`}>{m.merchant}</Link>
                  <span className="cat-merch-n label">{t("cat.merchantOps", { n: m.n })}</span>
                  <span className="num-mono">{formatMinor(Math.abs(m.spent), { decimals: false })} ₴</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  );
}
