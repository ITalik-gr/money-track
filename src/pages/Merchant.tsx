import { Link, useParams } from "react-router-dom";
import { Y_AXIS, Y_AXIS_LEFT_MARGIN } from "../lib/chart.ts";
import { dateFmt, numFmt } from "../i18n/locale.ts";
import { useT } from "../i18n/index.ts";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { useGetMerchantQuery } from "../store/api.ts";
import { MerchantLogo } from "../components/ui/MerchantLogo.tsx";
import { TxItem } from "../components/transactions/TxItem.tsx";
import { InfoTip } from "../components/ui/InfoTip.tsx";
import { formatMinor } from "../lib/format.ts";
import { CHART_ANIM } from "../lib/motion.ts";
import { baseSign } from "../lib/currency.ts";

// §P3: сторінка одного мерчанта — уся історія витрат, тренд 6 міс, середній чек, частка в
// категорії, перша/остання покупка. Дані канонічні (stats.ts), зведені в ₴.
const fmt0 = numFmt({ maximumFractionDigits: 0 });
const monthShort = dateFmt({ month: "short" });
const dateFull = dateFmt({ day: "numeric", month: "short", year: "numeric" });
const monthLabel = (m: string) => { const [y, mm] = m.split("-"); return monthShort.format(new Date(Number(y), Number(mm) - 1, 1)); };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MTooltip(props: any) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{p.label}</div>
      <div className="r"><span className="d" style={{ background: "var(--accent)" }} />{fmt0.format(p.spent)} {baseSign()}</div>
    </div>
  );
}

function Stat({ label, v, sub, color }: { label: string; v: React.ReactNode; sub?: string; color?: string | null }) {
  return (
    <div className="card merchant-stat">
      <div className="label">{label}</div>
      <div className="merchant-stat-v num-hero">
        {color && <span className="d" style={{ background: color, width: 9, height: 9, borderRadius: 999, display: "inline-block", marginRight: 7, verticalAlign: "middle" }} />}
        {v}
      </div>
      {sub && <div className="merchant-stat-sub">{sub}</div>}
    </div>
  );
}

export function Merchant() {
  const t = useT();
  const { name = "" } = useParams();
  const decoded = decodeURIComponent(name);
  const { data, isLoading } = useGetMerchantQuery(decoded, { skip: !decoded });

  const rows = (data?.by_month ?? []).map((r) => ({ month: r.month, spent: Math.round(r.spent / 100), label: monthLabel(r.month) }));

  return (
    <>
      <div className="page-head">
        <div className="row" style={{ gap: 12, minWidth: 0 }}>
          <MerchantLogo merchant={decoded} color="var(--accent)" fallbackLabel={decoded} />
          <div style={{ minWidth: 0 }}>
            <div className="greet" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{decoded}</div>
            <div className="sub">{t("mrc.sub")}</div>
          </div>
        </div>
        <div className="page-head-actions">
          <Link to="/stats" className="btn ghost sm">← {t("nav.stats")}</Link>
        </div>
      </div>

      {isLoading ? (
        <div className="card empty">{t("common.loading")}</div>
      ) : !data || (data.n === 0 && data.transactions.length === 0) ? (
        <div className="card empty">{t("mrc.emptyText")}</div>
      ) : (
        <div className="stack" style={{ gap: 18 }}>
          <div className="merchant-kpis">
            <Stat label={t("mrc.totalSpentLabel")} v={<>{formatMinor(data.total, { decimals: false })} <span className="cur">{baseSign()}</span></>} />
            <Stat label={t("stats.fact.txCount")} v={data.n} sub={data.first_at ? t("mrc.sinceDate", { date: dateFull.format(data.first_at * 1000) }) : undefined} />
            <Stat label={t("stats.fact.avgCheck")} v={<>{formatMinor(data.avg, { decimals: false })} <span className="cur">{baseSign()}</span></>} />
            {data.top_category && (
              <Stat label={t("mrc.categoryLabel")} v={data.top_category.name} color={data.top_category.color}
                sub={data.category_share != null ? t("mrc.categoryShareSub", { pct: data.category_share }) : undefined} />
            )}
          </div>

          {rows.length >= 2 && (
            <div className="card cashflow">
              <div className="cashflow-head">
                <span className="label" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  {t("mrc.trendTitle")}
                  <InfoTip>{t("mrc.trendTip")}</InfoTip>
                </span>
              </div>
              <div className="chart-wrap" style={{ height: 190 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={rows} margin={{ top: 8, right: 6, left: Y_AXIS_LEFT_MARGIN, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gMerch" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.1} />
                        <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} minTickGap={20} tick={{ fontSize: 11, fill: "var(--muted)" }} />
                    <YAxis {...Y_AXIS} tickCount={4}
                      tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                    <Tooltip content={<MTooltip />} cursor={{ stroke: "var(--line-strong)", strokeWidth: 1 }} />
                    <Area type="monotone" dataKey="spent" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" fill="url(#gMerch)" dot={{ r: 2.5 }} activeDot={{ r: 3.5 }} {...CHART_ANIM} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <section>
            <div className="section-head">
              <h2>{t("mrc.transactionsTitle")}</h2>
              <span className="label">{data.transactions.length}{data.transactions.length >= 40 ? "+" : ""}</span>
            </div>
            <div className="ledger rows">
              {data.transactions.map((t) => <TxItem key={t.id} t={t} />)}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
