/**
 * Statistics → Trends: the same money over time.
 *
 * Split out of `src/pages/Stats.tsx` on 2026-08-08. That file was 1 379 lines — the largest in the
 * project — and it had stopped being a page: it was five pages sharing a header. The cut follows
 * the TABS, because that is the boundary the user already sees and the one that decides what is
 * on screen; any other cut would have produced files nobody could name.
 *
 * `Stats.tsx` keeps what all five genuinely share: the period, the currency, the one
 * `/analytics/overview` request they all read. Everything a single tab owns lives here.
 */

import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { formatMinor } from "../../lib/format.ts";
import { useGetWeekdayQuery, useGetDayOfMonthQuery } from "../../store/api.ts";
import type { Overview, CashProjection } from "../../store/api.ts";
import { HoverTip } from "../ui/HoverTip.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { FactLabel, SliceDrillPanel, labelFor, weekdayLong, weekdayShort, type Cur } from "./shared.tsx";

/**
 * §1: the running net (income − spend) per bucket, plus §CASH-PROJ — the projected tail.
 *
 * ⚠️ **The forecast is no longer computed here.** It used to be a MEDIAN daily net repeated for
 * every remaining day, which is why the dashed line was always perfectly straight — the owner's
 * report: «предікт просто поступово кожен день знімає скільки в середньому витрачаю, завжди лінія
 * рівно плавно вниз». A median cannot know that rent leaves on the 20th or that the salary lands
 * on the 5th; it is built to discard exactly those, because in a flat model a lump would smear
 * across every day.
 *
 * The server now answers with per-day DELTAS (`/analytics/cash-projection`), built out of the
 * schedule (§SUB-MONTH, §INCOME-PLAN) and the calendar shape of ordinary spending (§WEEKDAY). This
 * function only accumulates them — a second running sum in the client is how a chart's two halves
 * end up disagreeing about the day they meet.
 */
export type CumPoint = { label: string; cum: number | null; proj?: number | null };
export function toCumulative(series: Overview["series"], projection?: CashProjection | null): CumPoint[] {
  let acc = 0;
  const rows: CumPoint[] = series.map((s) => { acc += (s.income - s.spend) / 100; return { label: labelFor(s.bucket), cum: Math.round(acc) }; });
  const daily = series.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.bucket));
  if (!projection?.days.length || !daily || rows.length < 2) return rows;

  const lastCum = rows[rows.length - 1].cum ?? 0;
  rows[rows.length - 1].proj = lastCum;   // the bridge from the actual line to the dashed one
  const dm = dateFmt({ day: "numeric", month: "numeric" });
  let proj = lastCum;
  for (const d of projection.days) {
    proj += (d.income - d.scheduled - d.ordinary) / 100;
    rows.push({
      label: dm.format(new Date(d.at * 1000)).replace(/\s/g, ""),
      cum: null,
      proj: Math.round(proj),
    });
  }
  return rows;
}

// Топ-5 найдорожчих днів періоду (з денних бакетів series). Клік — операції того дня.
// Розширює одиничний «найдорожчий день» у Глибшій аналітиці до рейтингу.
export function TopSpendDays({ series, sign, from, to, currency }: {
  series: Overview["series"]; sign: string; from: number; to: number; currency: Cur;
}) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const daily = series.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.bucket) && s.spend > 0);
  if (daily.length < 3) return null;
  const top = [...daily].sort((a, b) => b.spend - a.spend).slice(0, 5);
  const max = top[0]?.spend || 1;
  const dfmt = dateFmt({ weekday: "short", day: "numeric", month: "short" });
  return (
    <section>
      <div className="section-head"><h2>{t("stats.topDays.title")}</h2><span className="label">{t("stats.topDays.sub")}</span></div>
      <div className="card flush"><div className="catbars">
        {top.map((s) => {
          const isOpen = open === s.bucket;
          const d = new Date(s.bucket + "T00:00:00");
          return (
            <div key={s.bucket}>
              <button type="button" className={`catbar catbar-btn ${isOpen ? "open" : ""}`} onClick={() => setOpen(isOpen ? null : s.bucket)}>
                <span className="cb-name">{dfmt.format(d)}</span>
                <span className="cb-track"><span className="cb-fill" style={{ width: `${(s.spend / max) * 100}%`, background: "var(--accent)" }} /></span>
                <span className="cb-val">{formatMinor(s.spend, { decimals: false })} {sign}</span>
              </button>
              {isOpen && <SliceDrillPanel dim="day" value={s.bucket} from={from} to={to} currency={currency} sign={sign} />}
            </div>
          );
        })}
      </div></div>
    </section>
  );
}

// Глибша аналітика (обчислювана, без AI-вартості) — графіки по 2 в колонку + опис (§F1).
// Працює, коли бакет = день (тиждень/місяць): з денних сум виводимо патерни витрат.
export function DeeperAnalytics({ series, sign, from, to, currency }: {
  series: Overview["series"]; sign: string; from: number; to: number; currency: Cur;
}) {
  const t = useT();
  const [openWd, setOpenWd] = useState<number | null>(null);
  const [openPriciest, setOpenPriciest] = useState(false);
  const [openDom, setOpenDom] = useState<number | null>(null);
  const { data: wdData, error: wdErr, refetch: wdRefetch } = useGetWeekdayQuery({ from, to, currency });
  const { data: domData, error: domErr, refetch: domRefetch } = useGetDayOfMonthQuery({ from, to, currency });
  const daily = series.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.bucket));
  // A block that just disappears says "nothing here" for both an empty period and a failed
  // request; only the empty half is an answer (§Обробка помилок).
  const err = wdErr ?? domErr;
  if (err) return <ErrorNote error={err} what={t("stats.patterns.title")} onRetry={wdErr ? wdRefetch : domRefetch} />;
  if (daily.length < 4) return null;

  /**
   * §WEEKDAY and its day-of-month twin come from the SERVER.
   *
   * Both used to be derived right here, out of the daily buckets, and both were wrong in the two
   * ways `lib/finance/weekday.ts` exists to prevent. The buckets are `strftime('%Y-%m-%d')` in
   * UTC, so every purchase after 21:00 Kyiv time was filed on the FOLLOWING day — and Friday
   * evening is the densest spending window there is, which made the error look like a finding
   * ("Saturdays are expensive"). And the raw sums were never divided by how many such days the
   * window held: a month has five Fridays and four Saturdays, three 15ths and two 31sts.
   *
   * The canonical answer already existed and was already on screen elsewhere (`WeekdaySpend`, and
   * the advisor's own context reads the same function). This block was quietly disagreeing with
   * both about the same money.
   */
  const wd = wdData?.days ?? [];
  const wdTotal = wd.reduce((s, d) => s + d.spent, 0) || 1;
  const wdMax = Math.max(...wd.map((d) => d.typical), 1);
  const weekdaySum = wd.filter((d) => d.dow !== 0 && d.dow !== 6).reduce((s, d) => s + d.spent, 0);
  const weekendSum = wd.filter((d) => d.dow === 0 || d.dow === 6).reduce((s, d) => s + d.spent, 0);
  const weekendPct = wdData?.weekend_share_pct ?? 0;
  // `busiest` already excludes days carried by a single payment; the fallback is the plain
  // maximum, so the sentence still says something when every day is lumpy.
  const topWd = wdData?.busiest ?? (wd.length ? wd.reduce((b, d) => (d.typical > b.typical ? d : b)).dow : 0);

  // §1b: найдорожчий день + скільки днів без витрат за період.
  const priciest = daily.reduce<Overview["series"][number] | null>((m, s) => (s.spend > (m?.spend ?? -1) ? s : m), null);
  const totalDays = Math.max(1, Math.round((to - from) / 86400));
  const noSpendDays = Math.max(0, totalDays - daily.filter((s) => s.spend > 0).length);

  // §1: heat-map за числом місяця — «дорогі» дати (зарплата, оренда). Intensity is driven by
  // `typical`, not by the raw sum, for the reason above.
  const domDays = domData?.days ?? [];
  const domMax = Math.max(...domDays.map((d) => d.typical), 1);
  const hasDom = domDays.some((d) => d.spent > 0);

  return (
    <section>
      <div className="section-head"><h2>{t("stats.patterns.title")}</h2><span className="label">{t("stats.patterns.sub")}</span></div>
      <div className="stat-facts" style={{ marginBottom: 10 }}>
        <button type="button" className={`fact fact-click ${openPriciest ? "open" : ""}`}
          disabled={!priciest || !(priciest.spend > 0)}
          onClick={() => setOpenPriciest((o) => !o)}>
          <FactLabel info={<>{t("stats.patterns.priciestInfo")}</>}>{t("stats.patterns.priciest")}</FactLabel>
          <span className="fact-val">{priciest && priciest.spend > 0 ? <>{labelFor(priciest.bucket)} · {formatMinor(priciest.spend, { decimals: false })} {sign}</> : "—"}</span>
        </button>
        <div className="fact">
          <FactLabel info={<>{t("stats.patterns.noSpendDaysInfo")}</>}>{t("stats.patterns.noSpendDays")}</FactLabel>
          <span className="fact-val">{noSpendDays} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{t("common.of")} {totalDays}</span></span>
        </div>
      </div>
      {openPriciest && priciest && priciest.spend > 0 && (
        <div className="card drill-open-card" style={{ marginBottom: 14 }}>
          <div className="label" style={{ marginBottom: 6 }}>{t("stats.patterns.priciestDrill", { label: labelFor(priciest.bucket) })}</div>
          <SliceDrillPanel dim="day" value={priciest.bucket} from={from} to={to} currency={currency} sign={sign} embedded />
        </div>
      )}
      <div className="stats-2col">
        <div className="card deep-card">
          <div className="deep-title">{t("stats.patterns.byWd")} <span className="label" style={{ fontWeight: 400 }}>{t("stats.patterns.byWdSub")}</span></div>
          <div className="wd-bars">
            {wd.map((d) => (
              <HoverTip key={d.dow} content={
                <><div className="tip-lbl">{weekdayLong(d.dow)}</div>
                {/* The bar is the TYPICAL day; the tooltip carries the total too, because the
                    two answer different questions and the reader may want either. */}
                <div className="r">{formatMinor(d.typical, { decimals: false })} {sign} · {t("stats.patterns.typicalDay")}</div>
                <div className="r" style={{ color: "rgba(255,255,255,0.6)" }}>{formatMinor(d.spent, { decimals: false })} {sign} · {Math.round((d.spent / wdTotal) * 100)}{t("stats.patterns.pctOfPeriod")}</div></>
              }>
                <button type="button" className={`wd-col ${openWd === d.dow ? "open" : ""}`}
                  onClick={() => setOpenWd(openWd === d.dow ? null : d.dow)}>
                  {/* scaleY замість height (layout-thrash). Мінімум 0.02 — щоб дуже малий
                      день лишався видимим: min-height трансформ не рятує. */}
                  <div className="wd-bar-wrap"><div className="wd-bar" style={{ transform: `scaleY(${Math.max(0.02, d.typical / wdMax)})`, background: d.dow === topWd || d.dow === openWd ? "var(--accent)" : "var(--line-strong)" }} /></div>
                  <span className="wd-lbl">{weekdayShort(d.dow)}</span>
                </button>
              </HoverTip>
            ))}
          </div>
          <p className="deep-desc">{t("stats.patterns.topWdDesc", { weekday: weekdayLong(topWd), amount: formatMinor(wd.find((d) => d.dow === topWd)?.typical ?? 0, { decimals: false }), sign })}</p>
          {openWd != null && (
            <div className="wd-drill">
              <div className="label" style={{ marginBottom: 2 }}>{t("stats.patterns.wdDrill", { weekday: weekdayLong(openWd) })}</div>
              <SliceDrillPanel dim="weekday" value={String(openWd)} from={from} to={to} currency={currency} sign={sign} />
            </div>
          )}
        </div>

        <div className="card deep-card">
          <div className="deep-title">{t("stats.patterns.weekVsWeekend")}</div>
          <div className="split-bar">
            <HoverTip content={<><div className="tip-lbl">{t("stats.patterns.weekdayLabel")}</div><div className="r">{formatMinor(weekdaySum, { decimals: false })} {sign} · {100 - weekendPct}%</div></>}>
              <div className="split-seg" style={{ width: `${100 - weekendPct}%`, background: "var(--c-cobalt, var(--accent))" }}>{100 - weekendPct}%</div>
            </HoverTip>
            <HoverTip content={<><div className="tip-lbl">{t("stats.patterns.weekendLabel")}</div><div className="r">{formatMinor(weekendSum, { decimals: false })} {sign} · {weekendPct}%</div></>}>
              <div className="split-seg alt" style={{ width: `${weekendPct}%`, background: "var(--c-teal)" }}>{weekendPct}%</div>
            </HoverTip>
          </div>
          <div className="split-legend">
            <span><span className="d" style={{ background: "var(--accent)" }} />{t("stats.patterns.weekdayNote", { amount: formatMinor(weekdaySum, { decimals: false }), sign })}</span>
            <span><span className="d" style={{ background: "var(--c-teal)" }} />{t("stats.patterns.weekendNote", { amount: formatMinor(weekendSum, { decimals: false }), sign })}</span>
          </div>
          <p className="deep-desc">{weekendPct >= 40 ? t("stats.patterns.weekendHigh") : t("stats.patterns.weekendLow")}</p>
        </div>
      </div>

      {hasDom && (
        <div className="card deep-card" style={{ marginTop: 14 }}>
          <div className="deep-title">{t("stats.patterns.byDom")} <span className="label" style={{ fontWeight: 400 }}>{t("stats.patterns.byDomSub")}</span></div>
          <div className="dom-heat">
            {domDays.map((d) => {
              const intensity = d.typical > 0 ? 0.15 + 0.85 * (d.typical / domMax) : 0;
              return (
                <HoverTip key={d.dom} content={
                  <><div className="tip-lbl">{t("stats.patterns.domTip", { dom: d.dom })}</div>
                  <div className="r">{formatMinor(d.typical, { decimals: false })} {sign} · {t("stats.patterns.typicalDay")}</div>
                  {/* How many times this date occurred is what makes the cell comparable to its
                      neighbours, so it is shown rather than merely applied. */}
                  <div className="r" style={{ color: "rgba(255,255,255,0.6)" }}>{formatMinor(d.spent, { decimals: false })} {sign} · {t("stats.patterns.domTimes", { n: d.days })}</div></>
                }>
                  <button type="button" className={`dom-cell ${openDom === d.dom ? "open" : ""}`} disabled={!(d.spent > 0)}
                    onClick={() => setOpenDom((o) => (o === d.dom ? null : d.dom))}
                    style={{ background: d.typical > 0 ? `color-mix(in srgb, var(--accent) ${Math.round(intensity * 100)}%, transparent)` : "var(--surface-2)" }}>
                    <span className="dom-num" style={{ color: intensity > 0.55 ? "#fff" : "var(--muted)" }}>{d.dom}</span>
                  </button>
                </HoverTip>
              );
            })}
          </div>
          {openDom != null && (
            <div className="drill-open-card" style={{ marginTop: 12, padding: 0 }}>
              <div className="label" style={{ marginBottom: 6 }}>{t("stats.patterns.domDrill", { dom: openDom })}</div>
              <SliceDrillPanel dim="dom" value={String(openDom)} from={from} to={to} currency={currency} sign={sign} embedded />
            </div>
          )}
          <p className="deep-desc">
            {domData?.first_five_share_pct != null
              // The useful fact is not which date is dear but how much of the month is already
              // committed before any of it is decided — rent and subscriptions cluster in days 1–5.
              ? t("stats.patterns.domFirstFive", { pct: domData.first_five_share_pct })
              : t("stats.patterns.domDesc")}
          </p>
        </div>
      )}
    </section>
  );
}
