import { Link, useParams } from "react-router-dom";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { useGetMerchantQuery } from "../store/api.ts";
import { MerchantLogo } from "../components/MerchantLogo.tsx";
import { TxItem } from "../components/TxItem.tsx";
import { InfoTip } from "../components/InfoTip.tsx";
import { formatMinor } from "../lib/format.ts";
import { CHART_ANIM } from "../lib/motion.ts";

// §P3: сторінка одного мерчанта — уся історія витрат, тренд 6 міс, середній чек, частка в
// категорії, перша/остання покупка. Дані канонічні (stats.ts), зведені в ₴.
const fmt0 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
const monthShort = new Intl.DateTimeFormat("uk-UA", { month: "short" });
const dateFull = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short", year: "numeric" });
const monthLabel = (m: string) => { const [y, mm] = m.split("-"); return monthShort.format(new Date(Number(y), Number(mm) - 1, 1)); };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MTooltip(props: any) {
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
            <div className="sub">Історія витрат у цього мерчанта.</div>
          </div>
        </div>
        <div className="page-head-actions">
          <Link to="/stats" className="btn ghost sm">← Статистика</Link>
        </div>
      </div>

      {isLoading ? (
        <div className="card empty">Завантаження…</div>
      ) : !data || (data.n === 0 && data.transactions.length === 0) ? (
        <div className="card empty">Немає витрат у цього мерчанта.</div>
      ) : (
        <div className="stack" style={{ gap: 18 }}>
          <div className="merchant-kpis">
            <Stat label="Усього витрачено" v={<>{formatMinor(data.total, { decimals: false })} <span className="cur">₴</span></>} />
            <Stat label="Операцій" v={data.n} sub={data.first_at ? `з ${dateFull.format(data.first_at * 1000)}` : undefined} />
            <Stat label="Середній чек" v={<>{formatMinor(data.avg, { decimals: false })} <span className="cur">₴</span></>} />
            {data.top_category && (
              <Stat label="Категорія" v={data.top_category.name} color={data.top_category.color}
                sub={data.category_share != null ? `${data.category_share}% усіх витрат категорії` : undefined} />
            )}
          </div>

          {rows.length >= 2 && (
            <div className="card cashflow">
              <div className="cashflow-head">
                <span className="label" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  витрати · 6 міс
                  <InfoTip>Сума витрат у цього мерчанта по місяцях (зведено в ₴). Показує, чи росте чи спадає активність.</InfoTip>
                </span>
              </div>
              <div className="chart-wrap" style={{ height: 190 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={rows} margin={{ top: 8, right: 6, left: -14, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gMerch" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.1} />
                        <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} minTickGap={20} tick={{ fontSize: 11, fill: "var(--muted)" }} />
                    <YAxis tickLine={false} axisLine={false} width={46} tickCount={4} tick={{ fontSize: 11, fill: "var(--muted)" }}
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
              <h2>Операції</h2>
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
