import { catColor } from "../lib/theme.ts";
import { Link, useParams } from "react-router-dom";
import { ErrorNote } from "../components/ui/ErrorNote.tsx";
import { Y_AXIS, Y_AXIS_LEFT_MARGIN } from "../lib/chart.ts";
import { dateFmt, numFmt } from "../i18n/locale.ts";
import { useT } from "../i18n/index.ts";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { useGetMerchantQuery } from "../store/api.ts";
import { MerchantLogo } from "../components/ui/MerchantLogo.tsx";
import { TxItem } from "../components/transactions/TxItem.tsx";
import { InfoTip } from "../components/ui/InfoTip.tsx";
import { formatMinor } from "../lib/format.ts";
import { CHART_ANIM } from "../lib/motion.ts";
import { baseSign } from "../lib/currency.ts";
import { localDayStart, nowUnix } from "../../shared/time.ts";
import type { MerchantAnalytics, MerchantSide } from "../../shared/api/analytics.ts";

// §P3: one merchant, BOTH directions. A merchant is not always a shop — an employer or a client
// pays you — so the page words itself from `kind` instead of showing a salary payer as
// "spent 0 ₴". Figures are canonical (lib/finance/merchant.ts), in the reader's base.
const fmt0 = numFmt({ maximumFractionDigits: 0 });
const monthShort = dateFmt({ month: "short" });
const dateFull = dateFmt({ day: "numeric", month: "short", year: "numeric" });
const monthLabel = (m: string) => monthShort.format(new Date(`${m}-15T12:00:00Z`));

type T = ReturnType<typeof useT>;
const SERIES = { income: "var(--pos)", spent: "var(--accent)" } as const;
type SideKey = "spend" | "income";

const Amt = ({ v }: { v: number }) => <>{formatMinor(v, { decimals: false })} <span className="cur">{baseSign()}</span></>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MTooltip(props: any) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{p.label}</div>
      {payload.map((s: { dataKey: "income" | "spent"; name: string; value: number }) => (
        <div className="r" key={s.dataKey}><span className="d" style={{ background: SERIES[s.dataKey] }} />{s.name}: {fmt0.format(s.value)} {baseSign()}</div>
      ))}
    </div>
  );
}

function Stat({ label, v, sub, color }: { label: string; v: React.ReactNode; sub?: string; color?: string | null }) {
  return (
    <div className="card merchant-stat">
      <div className="label">{label}</div>
      <div className="merchant-stat-v num-hero">
        {color && <span className="d" style={{ background: catColor(color), width: 9, height: 9, borderRadius: 999, display: "inline-block", marginRight: 7, verticalAlign: "middle" }} />}
        {v}
      </div>
      {sub && <div className="merchant-stat-sub">{sub}</div>}
    </div>
  );
}

/** Kyiv calendar days since `at` (§APP_TZ) — "26 Sep" alone does not say how stale a payer is. */
function agoText(t: T, at: number): string {
  const d = Math.round((localDayStart(nowUnix()) - localDayStart(at)) / 86400);
  return d <= 0 ? t("mrc.today") : t("mrc.daysAgo", { n: d });
}

function cadence(t: T, days: number): string {
  // 27–33 days is a calendar month whatever its length; "every ~31 days" reads as a coincidence.
  return days >= 27 && days <= 33 ? t("mrc.everyMonthly") : t("mrc.everyDays", { n: days });
}

function SideTiles({ t, s, k }: { t: T; s: MerchantSide; k: SideKey }) {
  const income = k === "income";
  return (
    <div className="merchant-kpis">
      <Stat label={t(income ? "mrc.totalIncomeLabel" : "mrc.totalSpentLabel")} v={<Amt v={s.total} />} />
      <Stat label={t("stats.fact.txCount")} v={s.n}
        sub={s.first_at ? t("mrc.sinceDate", { date: dateFull.format(s.first_at * 1000) }) : undefined} />
      <Stat label={t(income ? "mrc.avgIncomeLabel" : "stats.fact.avgCheck")} v={<Amt v={s.avg} />} />
      {s.last_at != null && (
        <Stat label={t("mrc.lastLabel")} v={dateFull.format(s.last_at * 1000)} sub={agoText(t, s.last_at)} />
      )}
      {s.every_days != null && (
        <Stat label={t("mrc.everyLabel")} v={cadence(t, s.every_days)} sub={t("mrc.everySub", { n: s.n })} />
      )}
      {s.top_category && (
        <Stat label={t("mrc.categoryLabel")} v={s.top_category.name} color={s.top_category.color}
          sub={s.category_share != null
            ? t(income ? "mrc.incomeShareSub" : "mrc.categoryShareSub", { pct: s.category_share })
            : undefined} />
      )}
    </div>
  );
}

function subtitle(t: T, kind: MerchantAnalytics["kind"]): string {
  return kind === "income" ? t("mrc.subIncome") : kind === "mixed" ? t("mrc.subMixed") : kind === "none" ? t("mrc.subNone") : t("mrc.sub");
}

export function Merchant() {
  const t = useT();
  const { name = "" } = useParams();
  const decoded = decodeURIComponent(name);
  const { data, isLoading, isError, error, refetch } = useGetMerchantQuery(decoded, { skip: !decoded });
  // A failed request and a merchant with no history would otherwise render the SAME empty page
  // (C17 — a page reading `data?.x ?? []` must have an error branch).
  if (isError) return <ErrorNote error={error} what={decoded} onRetry={refetch} />;

  const showSpend = !!data && data.spend.n + data.refunds.n > 0;
  const showIncome = !!data && data.income.n > 0;
  // The side with more money leads: an employer who once sold you something is still an employer.
  const order: SideKey[] = data && data.income.total > data.spend.total ? ["income", "spend"] : ["spend", "income"];
  const sides = order.filter((k) => (k === "spend" ? showSpend : showIncome));

  const rows = (data?.by_month ?? []).map((r) => ({
    month: r.month, label: monthLabel(r.month),
    spent: Math.round(r.spent / 100), income: Math.round(r.income / 100),
  }));
  const year = (data?.by_month ?? []).reduce((a, r) => ({ spent: a.spent + r.spent, income: a.income + r.income }), { spent: 0, income: 0 });
  const activeMonths = rows.filter((r) => r.spent !== 0 || r.income !== 0).length;

  return (
    <>
      <div className="page-head">
        <div className="row" style={{ gap: 12, minWidth: 0 }}>
          <MerchantLogo merchant={decoded} color="var(--accent)" fallbackLabel={decoded} />
          <div style={{ minWidth: 0 }}>
            <div className="greet" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{decoded}</div>
            <div className="sub">{data ? subtitle(t, data.kind) : t("mrc.sub")}</div>
          </div>
        </div>
        <div className="page-head-actions">
          <Link to="/stats" className="btn ghost sm">← {t("nav.stats")}</Link>
        </div>
      </div>

      {isLoading ? (
        <div className="card empty">{t("common.loading")}</div>
      ) : !data || data.total_n === 0 ? (
        <div className="card empty">{t("mrc.emptyText")}</div>
      ) : (
        <div className="stack" style={{ gap: 18 }}>
          {data.kind === "mixed" && (
            <p className="merchant-net">
              {t("mrc.sideIncome")} <b className="pos"><Amt v={data.income.total} /></b>
              {" · "}{t("mrc.sideSpend")} <b><Amt v={data.spend.total} /></b>
              {" · "}{t("mrc.net")} <b className={data.income.total - data.spend.total >= 0 ? "pos" : "neg"}>
                {data.income.total - data.spend.total >= 0 ? "+" : "−"}<Amt v={Math.abs(data.income.total - data.spend.total)} />
              </b>
            </p>
          )}

          {sides.map((k) => (
            <section key={k}>
              {sides.length > 1 && (
                <div className="section-head"><h2>{t(k === "income" ? "mrc.sideIncome" : "mrc.sideSpend")}</h2></div>
              )}
              <SideTiles t={t} s={data[k]} k={k} />
            </section>
          ))}

          {(data.refunds.n > 0 || data.other_n > 0) && (
            <div className="merchant-notes">
              {data.refunds.n > 0 && (
                <p>{t("mrc.refundsNote", { sum: `${formatMinor(data.refunds.total, { decimals: false })} ${baseSign()}`, n: data.refunds.n })}</p>
              )}
              {data.other_n > 0 && <p>{t("mrc.otherNote", { n: data.other_n })}</p>}
            </div>
          )}

          {activeMonths >= 2 && (
            <div className="card cashflow">
              <div className="cashflow-head">
                <div>
                  <span className="label" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    {t("mrc.trendTitle")}
                    <InfoTip>{t("mrc.trendTip")}</InfoTip>
                  </span>
                  <div className="merchant-year">
                    {t("mrc.last12")}:{" "}
                    {showIncome && <b className="pos">+<Amt v={year.income} /></b>}
                    {showIncome && showSpend && " · "}
                    {showSpend && <b>−<Amt v={year.spent} /></b>}
                  </div>
                </div>
                {showIncome && showSpend && (
                  <div className="legend">
                    <span><span className="d" style={{ background: SERIES.income }} />{t("common.income")}</span>
                    <span><span className="d" style={{ background: SERIES.spent }} />{t("common.expenses")}</span>
                  </div>
                )}
              </div>
              <div className="chart-wrap" style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rows} margin={{ top: 8, right: 6, left: Y_AXIS_LEFT_MARGIN, bottom: 0 }} barGap={2}>
                    <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} minTickGap={8} tick={{ fontSize: 11, fill: "var(--muted)" }} />
                    <YAxis {...Y_AXIS} tickCount={4}
                      tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                    <Tooltip content={<MTooltip />} cursor={{ fill: "var(--surface-2)", opacity: 0.5 }} />
                    {showIncome && <Bar dataKey="income" name={t("common.income")} fill={SERIES.income} radius={[3, 3, 0, 0]} maxBarSize={28} {...CHART_ANIM} />}
                    {showSpend && <Bar dataKey="spent" name={t("common.expenses")} fill={SERIES.spent} radius={[3, 3, 0, 0]} maxBarSize={28} {...CHART_ANIM} />}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <section>
            <div className="section-head">
              <h2>{t("mrc.transactionsTitle")}</h2>
              <span className="label">{data.total_n}</span>
            </div>
            <div className="ledger rows">
              {data.transactions.map((tx) => <TxItem key={tx.id} t={tx} />)}
            </div>
            {data.has_more && (
              <Link to={`/transactions?q=${encodeURIComponent(decoded)}`} className="btn ghost sm merchant-more">{t("mrc.allTx")}</Link>
            )}
          </section>
        </div>
      )}
    </>
  );
}
