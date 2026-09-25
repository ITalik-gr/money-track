/**
 * «Коли ти витрачаєш» — the ONE «when» block of Statistics → Trends (UI_PASS ST2, 2026-09-25).
 *
 * It replaced five: «Найдорожчі дні», «Глибша аналітика» (priciest day, days without spending,
 * weekdays, weekdays vs weekend, day of month) and «За днями тижня». The owner: «багато, схожі й
 * не дуже інформативні» — and they were literally the same answer twice: two weekday charts over
 * the same `/analytics/weekday`, each with its own busiest day and weekend share.
 *
 * The shape now: three facts, one chart with a weekday / day-of-month switch, and the priciest
 * days as highlights under it. Every bar, cell and highlight opens the operations behind it, in
 * one drill slot — two open drills on one block was a scroll with no end.
 *
 * Numbers: the weekday / day-of-month TYPICAL day is the server's (`lib/finance/weekday.ts` —
 * divided by how many such days the window held); nothing about them is recomputed here.
 */
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { formatMinor } from "../../lib/format.ts";
import { useGetWeekdayQuery, useGetDayOfMonthQuery } from "../../store/api.ts";
import type { Overview } from "../../store/api.ts";
import { HoverTip, TipBody } from "../ui/HoverTip.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { FactLabel, SliceDrillPanel, weekdayLong, weekdayShort, type Cur } from "./shared.tsx";

const dayFmt = dateFmt({ weekday: "short", day: "numeric", month: "short" });
/** The reader's week starts on Monday; `dow` follows SQL (0 = Sunday). */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

type Open = { dim: "weekday" | "dom" | "day"; value: string; label: string } | null;

export function SpendTiming({ series, sign, from, to, currency }: {
  series: Overview["series"]; sign: string; from: number; to: number; currency: Cur;
}) {
  const t = useT();
  const [view, setView] = useState<"week" | "month">("week");
  const [open, setOpen] = useState<Open>(null);
  const wdQ = useGetWeekdayQuery({ from, to, currency });
  const domQ = useGetDayOfMonthQuery({ from, to, currency });
  const err = wdQ.error ?? domQ.error;
  if (err) return <ErrorNote error={err} what={t("stats.when.title")} onRetry={() => { void wdQ.refetch(); void domQ.refetch(); }} />;
  const wd = wdQ.data;
  if (!wd) return null;
  const spentTotal = wd.days.reduce((s, d) => s + d.spent, 0);
  if (spentTotal === 0) return null; // an empty period: this block is not about history

  const toggle = (o: NonNullable<Open>) => setOpen((cur) => (cur && cur.dim === o.dim && cur.value === o.value ? null : o));
  const isOpen = (dim: NonNullable<Open>["dim"], value: string) => open?.dim === dim && open.value === value;

  const days = WEEK.map((dow) => wd.days.find((d) => d.dow === dow)).filter((d): d is NonNullable<typeof d> => !!d);
  const wdMax = Math.max(...days.map((d) => d.typical), 1);
  const busiest = wd.busiest != null ? days.find((d) => d.dow === wd.busiest) ?? null : null;
  const weekendSum = days.filter((d) => d.dow === 0 || d.dow === 6).reduce((s, d) => s + d.spent, 0);
  const weekendPct = wd.weekend_share_pct;

  // Daily facts exist only when the overview is bucketed by day (week / month presets).
  const daily = series.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.bucket));
  const spentDays = daily.filter((s) => s.spend > 0);
  const top = [...spentDays].sort((a, b) => b.spend - a.spend).slice(0, 5);
  const totalDays = Math.max(1, Math.round((to - from) / 86400));
  const noSpend = daily.length >= 4 ? Math.max(0, totalDays - spentDays.length) : null;

  const dom = domQ.data?.days ?? [];
  const domMax = Math.max(...dom.map((d) => d.typical), 1);
  const money = (m: number) => `${formatMinor(m, { decimals: false })} ${sign}`;

  return (
    <section>
      <div className="section-head"><h2>{t("stats.when.title")}</h2><span className="label">{t("stats.when.sub")}</span></div>
      <div className="stat-facts" style={{ marginBottom: 12 }}>
        <div className="fact">
          <FactLabel info={<>{t("wd.tip")}</>}>{t("stats.when.busiest")}</FactLabel>
          <span className="fact-val">{busiest ? <>{weekdayLong(busiest.dow)} · {money(busiest.typical)}</> : "—"}</span>
        </div>
        <div className="fact">
          <FactLabel>{t("stats.when.weekend")}</FactLabel>
          <span className="fact-val">
            {weekendPct != null ? `${weekendPct}%` : "—"}
            <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{money(weekendSum)}</span>
          </span>
        </div>
        {noSpend != null && (
          <div className="fact">
            <FactLabel info={<>{t("stats.patterns.noSpendDaysInfo")}</>}>{t("stats.patterns.noSpendDays")}</FactLabel>
            <span className="fact-val">{noSpend} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{t("common.of")} {totalDays}</span></span>
          </div>
        )}
      </div>

      <div className="card deep-card">
        <div className="when-head">
          <div className="seg" role="tablist" aria-label={t("stats.when.title")}>
            <button type="button" role="tab" aria-selected={view === "week"} className={`seg-btn ${view === "week" ? "active" : ""}`} onClick={() => setView("week")}>{t("stats.when.byWd")}</button>
            <button type="button" role="tab" aria-selected={view === "month"} className={`seg-btn ${view === "month" ? "active" : ""}`} onClick={() => setView("month")}>{t("stats.when.byDom")}</button>
          </div>
          <span className="label">{t("stats.when.typical")}</span>
        </div>

        {view === "week" ? (
          <>
            <div className="wd-bars">
              {days.map((d) => (
                <HoverTip key={d.dow} content={<TipBody label={weekdayLong(d.dow)} value={<>{money(d.typical)} · {t("stats.patterns.typicalDay")}</>}
                  sub={<>{money(d.spent)} · {Math.round((d.spent / spentTotal) * 100)}{t("stats.patterns.pctOfPeriod")}</>} />}>
                  <button type="button" className={`wd-col ${isOpen("weekday", String(d.dow)) ? "open" : ""}`}
                    onClick={() => toggle({ dim: "weekday", value: String(d.dow), label: t("stats.patterns.wdDrill", { weekday: weekdayLong(d.dow) }) })}>
                    {/* A day carried by one payment (rent) is drawn hatched, not hidden: it is true,
                        just not a habit. */}
                    <div className="wd-bar-wrap">
                      <div className={`wd-bar${d.lumpy ? " lumpy" : ""}${d.dow === wd.busiest ? " busiest" : ""}`}
                        style={{ transform: `scaleY(${Math.max(0.02, d.typical / wdMax)})` }} />
                    </div>
                    <span className="wd-lbl">{weekdayShort(d.dow)}</span>
                  </button>
                </HoverTip>
              ))}
            </div>
            <p className="deep-desc">{weekendPct != null && weekendPct >= 40 ? t("stats.patterns.weekendHigh") : t("stats.patterns.weekendLow")}</p>
          </>
        ) : (
          <>
            <div className="dom-heat">
              {dom.map((d) => {
                const intensity = d.typical > 0 ? 0.15 + 0.85 * (d.typical / domMax) : 0;
                return (
                  <HoverTip key={d.dom} content={<TipBody label={t("stats.patterns.domTip", { dom: d.dom })} value={<>{money(d.typical)} · {t("stats.patterns.typicalDay")}</>}
                    sub={<>{money(d.spent)} · {t("stats.patterns.domTimes", { n: d.days })}</>} />}>
                    <button type="button" className={`dom-cell ${isOpen("dom", String(d.dom)) ? "open" : ""}`} disabled={!(d.spent > 0)}
                      onClick={() => toggle({ dim: "dom", value: String(d.dom), label: t("stats.patterns.domDrill", { dom: d.dom }) })}
                      style={{ background: d.typical > 0 ? `color-mix(in srgb, var(--accent) ${Math.round(intensity * 100)}%, transparent)` : "var(--surface-2)" }}>
                      <span className="dom-num" style={{ color: intensity > 0.55 ? "#fff" : "var(--muted)" }}>{d.dom}</span>
                    </button>
                  </HoverTip>
                );
              })}
            </div>
            <p className="deep-desc">
              {domQ.data?.first_five_share_pct != null
                ? t("stats.patterns.domFirstFive", { pct: domQ.data.first_five_share_pct })
                : t("stats.patterns.domDesc")}
            </p>
          </>
        )}

        {top.length >= 3 && (
          <div className="when-top">
            <span className="label">{t("stats.when.topDays")}</span>
            <div className="when-chips">
              {top.map((s) => (
                <button key={s.bucket} type="button" className={`chip ${isOpen("day", s.bucket) ? "on" : ""}`}
                  onClick={() => toggle({ dim: "day", value: s.bucket, label: t("stats.patterns.priciestDrill", { label: dayFmt.format(new Date(`${s.bucket}T12:00:00Z`)) }) })}>
                  {dayFmt.format(new Date(`${s.bucket}T12:00:00Z`))} · <b>{money(s.spend)}</b>
                </button>
              ))}
            </div>
          </div>
        )}

        {open && (
          <div className="wd-drill">
            <div className="label" style={{ marginBottom: 6 }}>{open.label}</div>
            <SliceDrillPanel dim={open.dim} value={open.value} from={from} to={to} currency={currency} sign={sign} embedded />
          </div>
        )}
      </div>
    </section>
  );
}
