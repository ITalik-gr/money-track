import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Y_AXIS, Y_AXIS_LEFT_MARGIN } from "../../lib/chart.ts";
import { CHART_ANIM } from "../../lib/motion.ts";
import { useT } from "../../i18n/index.ts";

import { useGetMonthlyHistoryQuery } from "../../store/api.ts";
import { formatMinor, monthShort } from "../../lib/format.ts";
import { baseSign } from "../../lib/currency.ts";
import { EmptyCard } from "../ui/EmptyCard.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { FALLBACK } from "./shared.tsx";

/**
 * §MONTH-STACK — one bar per month, split by category.
 *
 * What the page could not answer before: the monthly-history strip says how much each month cost
 * and the category tab says where THIS period's money went, and nothing joined the two. «Скільки
 * я витрачав кожного місяця і на що саме» was the owner's request, and the honest reading of it
 * is a stacked bar — the height is the month, the segments are the reasons.
 *
 * ⚠️ The segments are decided by the SERVER, once, over the whole window (`data.categories`), not
 * per month. A stack whose segments change identity from bar to bar is not comparable, and
 * comparison is the only reason to draw the months side by side.
 * ⚠️ Clicking a bar opens `?ym=` — the same month, on the whole page. A chart that shows a spike
 * and cannot be asked about it is where the next question dies.
 */
const fmtMonth = (ym: string): string => {
  const m = Number(ym.slice(5)) - 1;
  // `monthShort` follows the locale (§i18n) — never a hardcoded array.
  return `${monthShort(m)} ${ym.slice(2, 4)}`;
};

interface Slice { key: string; name: string; color: string }

function StackTip({ active, payload, label, slices }: {
  active?: boolean; payload?: { dataKey?: string | number; value?: number }[]; label?: string; slices: Slice[];
}) {
  const t = useT();
  if (!active || !payload?.length) return null;
  const by = new Map(payload.map((p) => [String(p.dataKey), p.value ?? 0]));
  const total = [...by.values()].reduce((s, v) => s + v, 0);
  // Biggest first: the tooltip answers "what made this month", and the answer is at the top.
  const rows = slices.filter((s) => (by.get(s.key) ?? 0) > 0).sort((a, b) => (by.get(b.key) ?? 0) - (by.get(a.key) ?? 0));
  return (
    <div className="chart-tip">
      <div className="tip-lbl">{label}</div>
      {rows.map((s) => (
        <div className="r" key={s.key}>
          <span className="d" style={{ background: s.color }} />
          {s.name} · {formatMinor((by.get(s.key) ?? 0) * 100, { decimals: false })}
        </div>
      ))}
      <div className="r tip-total">{t("stats.compare.totalSpend")} · {formatMinor(total * 100, { decimals: false })}</div>
    </div>
  );
}

export function MonthStack() {
  // §SIGN-FOLLOWS-DATA: `/analytics/monthly-history` takes no `currency`, so the page's currency
  // filter must not sign these bars. See `FxCostCard` for the report this came from.
  const sign = baseSign();
  const t = useT();
  const nav = useNavigate();
  const [months, setMonths] = useState(12);
  const { data, error, refetch } = useGetMonthlyHistoryQuery({ months });
  // A block that just disappears says "nothing here" for both an empty period and a failed
  // request; only the empty half is an answer (§Обробка помилок).
  if (error) return <ErrorNote error={error} what={t("mh.stackTitle")} onRetry={refetch} />;
  if (!data) return null;

  // The CURRENT month is excluded: a partial bar beside complete ones reads as a collapse in
  // spending, which is the one thing this chart must not invent. Same rule as the level canon.
  const rows = data.months.slice(0, -1);
  if (rows.length === 0) return <EmptyCard title={t("mh.stackTitle")} hint={t("mh.stackEmpty")} />;

  const slices: Slice[] = data.categories.map((c, i) => ({
    key: c.other ? "other" : String(c.id ?? "none"),
    name: c.name,
    // A seeded category carries its own colour; "other" and uncategorised have none, so they take
    // the shared fallback ramp rather than inventing a palette this chart alone would use.
    color: c.color ?? FALLBACK[i % FALLBACK.length],
  }));

  const chart = rows.map((m) => {
    const row: Record<string, number | string> = { label: fmtMonth(m.month), ym: m.month };
    for (const s of slices) row[s.key] = Math.round((m.by_category[s.key] ?? 0) / 100);
    return row;
  });

  return (
    <section>
      <div className="section-head">
        <h2>{t("mh.stackTitle")}</h2>
        <div className="seg sm">
          {[6, 12, 24].map((n) => (
            <button key={n} className={`seg-btn ${months === n ? "active" : ""}`} onClick={() => setMonths(n)}>{n}</button>
          ))}
        </div>
      </div>
      <div className="card chart-card">
        <div className="label" style={{ marginBottom: 8 }}>{t("mh.stackSub")}</div>
        <div className="chart-wrap" style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} margin={{ top: 8, right: 6, left: Y_AXIS_LEFT_MARGIN, bottom: 0 }}
              // The clicked bar, by INDEX into the data we handed in — `activeTooltipIndex` is the
              // one field recharts types for a click, and reading our own row back is safer than
              // trusting a payload shape the library is free to change.
              onClick={(e) => {
                const i = typeof e?.activeTooltipIndex === "number" ? e.activeTooltipIndex : -1;
                const ym = chart[i]?.ym;
                if (typeof ym === "string") nav(`/stats?ym=${ym}`);
              }}>
              <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} dy={6} tick={{ fontSize: 11, fill: "var(--muted)" }} />
              <YAxis {...Y_AXIS} tickCount={4} tick={{ fontSize: 11, fill: "var(--muted)" }}
                tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
              <Tooltip content={<StackTip slices={slices} />} cursor={{ fill: "var(--surface-2)", opacity: 0.5 }} />
              {slices.map((s, i) => (
                <Bar key={s.key} dataKey={s.key} stackId="m" fill={s.color} maxBarSize={44} cursor="pointer"
                  // Only the topmost segment is rounded, or every band would look like its own bar.
                  radius={i === slices.length - 1 ? [3, 3, 0, 0] : undefined} {...CHART_ANIM} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="legend ms-legend">
          {slices.map((s) => (
            <span key={s.key}><span className="d" style={{ background: s.color }} />{s.name}</span>
          ))}
          <span className="ms-unit">{sign}</span>
        </div>
      </div>
    </section>
  );
}
