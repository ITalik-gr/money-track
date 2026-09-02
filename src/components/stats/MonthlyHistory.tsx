import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Y_AXIS, Y_AXIS_LEFT_MARGIN } from "../../lib/chart.ts";
import { numFmt } from "../../i18n/locale.ts";
import { useT } from "../../i18n/index.ts";
import { CHART_ANIM } from "../../lib/motion.ts";
import { useGetMonthlyHistoryQuery } from "../../store/api.ts";
import { HoverTip } from "../ui/HoverTip.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { monthShort } from "../../lib/format.ts";
import { IMPORTANCE_META } from "../../lib/importance.ts";
import { baseSign } from "../../lib/currency.ts";

const monLbl = (m: string) => monthShort(Number(m.split("-")[1]) - 1) ?? m;
const fmt0 = numFmt({ maximumFractionDigits: 0 });

type Row = {
  label: string; spend: number; income: number; net: number; rate: number | null; current: boolean;
  // §IMPORTANCE-TREND — hryvnia, already rolled up. The three add up to `spend` by construction
  // (`EFF_IMPORTANCE` defaults to discretionary), which is what lets the strip below be read as a
  // share of the month rather than as three unrelated bars.
  essential: number; discretionary: number; optional: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MhTooltip(props: any) {
  const t = useT();
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const r: Row = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{r.label}{r.current ? t("mh.currentSuffix") : ""}</div>
      <div className="r"><span className="d" style={{ background: "var(--chart-income)" }} />{t("mh.incomeLabel")}: {fmt0.format(r.income)} {baseSign()}</div>
      <div className="r"><span className="d" style={{ background: "var(--chart-expense)" }} />{t("common.expenses")}: {fmt0.format(r.spend)} {baseSign()}</div>
      <div className="r tip-net" style={{ color: r.net >= 0 ? "var(--chart-income)" : "var(--chart-expense)" }}>
        <span className="d" style={{ background: "transparent" }} />{t("mh.netLabel")}: {r.net >= 0 ? "+" : ""}{fmt0.format(r.net)} {baseSign()}
      </div>
    </div>
  );
}

// 6-місячний тренд spend/income/net (канонічний /analytics/monthly-history) + норма
// заощаджень по місяцях. Довгий горизонт, якого не давали періодні вкладки.
export function MonthlyHistory() {
  const t = useT();
  const { data, error, refetch } = useGetMonthlyHistoryQuery({ months: 6 });
  // A block that just disappears says "nothing here" for both an empty period and a failed
  // request; only the empty half is an answer (§Обробка помилок).
  if (error) return <ErrorNote error={error} what={t("mh.historyTitle")} onRetry={refetch} />;
  if (!data || data.months.length === 0) return null;
  const rows: Row[] = data.months.map((m, i) => {
    const spend = m.spend / 100, income = m.income / 100;
    return {
      label: monLbl(m.month), spend, income, net: income - spend,
      essential: m.essential / 100, discretionary: m.discretionary / 100, optional: m.optional / 100,
      // §savingsRatePct — the server's number, not a third spelling of it. The AI report has
      // quoted `savings_rate_pct` since 2026-07 and this strip computed its own; identical today,
      // and nothing would have said so on the day one of them changed.
      rate: m.savings_rate_pct,
      current: i === data.months.length - 1,
    };
  });
  const hasAny = rows.some((r) => r.spend > 0 || r.income > 0);
  if (!hasAny) return null;
  const rateMax = Math.max(20, ...rows.map((r) => Math.abs(r.rate ?? 0)));

  return (
    <section>
      <div className="section-head">
        <h2>{t("mh.historyTitle")}</h2>
        <HoverTip content={<>{t("mh.tipPre")}<b>{t("mh.tipBold")}</b>{t("mh.tipPost")}</>}>
          <span className="label">{t("mh.sixMoWhatIsThis")}</span>
        </HoverTip>
      </div>
      <div className="card mh-card">
        <div className="legend" style={{ justifyContent: "flex-end", padding: "0 2px 8px" }}>
          <span><span className="d" style={{ background: "var(--chart-income)" }} />{t("mh.incomeLabel")}</span>
          <span><span className="d" style={{ background: "var(--chart-expense)" }} />{t("common.expenses")}</span>
          <span><span className="d" style={{ background: "var(--accent)" }} />{t("mh.netLabel")}</span>
        </div>
        <div className="chart-wrap" style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 6, left: Y_AXIS_LEFT_MARGIN, bottom: 0 }} barGap={2}>
              <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} tick={{ fontSize: 11, fill: "var(--muted)" }} />
              <YAxis {...Y_AXIS} tickCount={4}
               
                tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
              <Tooltip content={<MhTooltip />} cursor={{ fill: "var(--surface-2)", opacity: 0.5 }} />
              <Bar dataKey="income" fill="var(--chart-income)" radius={[3, 3, 0, 0]} maxBarSize={22} {...CHART_ANIM} />
              <Bar dataKey="spend" fill="var(--chart-expense)" radius={[3, 3, 0, 0]} maxBarSize={22} {...CHART_ANIM} />
              <Line type="monotone" dataKey="net" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" dot={{ r: 2.5, fill: "var(--accent)" }} activeDot={{ r: 4 }} {...CHART_ANIM} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="mh-rates">
          <div className="mh-rates-head">
            <span className="label">{t("mh.savingsRateLabel")}</span>
            <InfoTip>{t("mh.savingsRateTip")}</InfoTip>
          </div>
          <div className="mh-rate-bars">
            {rows.map((r, i) => (
              <HoverTip key={i} content={<><div className="tip-lbl">{r.label}{r.current ? t("mh.currentSuffix") : ""}</div><div className="r">{t("mh.rateValue", { value: r.rate != null ? `${r.rate}%` : "—" })}</div></>}>
                <div className="mh-rate-col">
                  <div className="mh-rate-track">
                    {r.rate != null && r.rate >= 0 && <span className="mh-rate-fill pos" style={{ height: `${Math.min(100, (r.rate / rateMax) * 50)}%` }} />}
                    {r.rate != null && r.rate < 0 && <span className="mh-rate-fill neg" style={{ height: `${Math.min(100, (-r.rate / rateMax) * 50)}%` }} />}
                  </div>
                  <span className={`mh-rate-val ${r.rate == null ? "muted" : r.rate >= 0 ? "pos" : "neg"}`}>{r.rate != null ? `${r.rate}%` : "—"}</span>
                  <span className="mh-rate-lbl">{r.label}</span>
                </div>
              </HoverTip>
            ))}
          </div>
        </div>

        {/* §IMPORTANCE-TREND — is the OPTIONAL share climbing?
            The period tabs already say what share of THIS month was optional; only a trend can say
            whether it is growing. A rising total on its own is ambiguous — a bigger rent and a
            bigger takeaway habit look identical in it, and only one of them is a decision anyone
            can revisit. Stacked to 100% deliberately: the question is about SHARE, and stacking by
            amount would let a big month hide a worsening mix. */}
        {rows.some((r) => r.spend > 0) && (
          <div className="mh-weights">
            <div className="mh-rates-head">
              <span className="label">{t("mh.weightsLabel")}</span>
              <InfoTip>{t("mh.weightsTip")}</InfoTip>
            </div>
            <div className="mh-weight-bars">
              {rows.map((r, i) => {
                const tot = r.essential + r.discretionary + r.optional;
                const pct = (v: number) => (tot > 0 ? (v / tot) * 100 : 0);
                return (
                  <HoverTip key={i} content={
                    <>
                      <div className="tip-lbl">{r.label}{r.current ? t("mh.currentSuffix") : ""}</div>
                      <div className="r"><span className="d" style={{ background: IMPORTANCE_META.essential.color }} />{t(IMPORTANCE_META.essential.shortKey)}: {Math.round(pct(r.essential))}%</div>
                      <div className="r"><span className="d" style={{ background: IMPORTANCE_META.discretionary.color }} />{t(IMPORTANCE_META.discretionary.shortKey)}: {Math.round(pct(r.discretionary))}%</div>
                      <div className="r"><span className="d" style={{ background: IMPORTANCE_META.optional.color }} />{t(IMPORTANCE_META.optional.shortKey)}: {Math.round(pct(r.optional))}%</div>
                    </>
                  }>
                    <div className="mh-weight-col">
                      <div className="mh-weight-track">
                        {/* A month with no spending renders an empty track rather than nothing:
                            a missing column would read as a missing month. */}
                        <span style={{ height: `${pct(r.essential)}%`, background: IMPORTANCE_META.essential.color }} />
                        <span style={{ height: `${pct(r.discretionary)}%`, background: IMPORTANCE_META.discretionary.color }} />
                        <span style={{ height: `${pct(r.optional)}%`, background: IMPORTANCE_META.optional.color }} />
                      </div>
                      <span className="mh-rate-lbl">{r.label}</span>
                    </div>
                  </HoverTip>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
