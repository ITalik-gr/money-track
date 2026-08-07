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
import type { Overview } from "../../store/api.ts";
import { HoverTip } from "../ui/HoverTip.tsx";
import { FactLabel, SliceDrillPanel, labelFor, weekdayLong, weekdayShort, type Cur } from "./shared.tsx";

// §1: накопичена чиста різниця (надходження − витрати) по бакетах — для running-balance лінії.
// opts (лише календарний, незавершений період, денні бакети) додає прогноз-хвіст (proj):
// пунктир на решту днів періоду за середнім денним темпом.
export type CumPoint = { label: string; cum: number | null; proj?: number | null };
export function toCumulative(series: Overview["series"], opts?: { mode: string; to: number; days: number; periodLen: number }): CumPoint[] {
  let acc = 0;
  const rows: CumPoint[] = series.map((s) => { acc += (s.income - s.spend) / 100; return { label: labelFor(s.bucket), cum: Math.round(acc) }; });
  const daily = series.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.bucket));
  if (!opts || opts.mode !== "calendar" || !daily || rows.length < 2) return rows;
  const remaining = opts.periodLen - opts.days;
  if (remaining <= 0) return rows;
  const lastCum = rows[rows.length - 1].cum ?? 0;
  // Нахил — МЕДІАНА денного нетто, не середнє. Середнє (= lastCum/days) розмазує разовий
  // лумп (напр. зайшла +31k зарплата одного дня) як щоденний приплив і тягне пунктир угору,
  // ніби дохід капає щодня. Медіана відкидає такий одноденний викид → нахил відображає
  // звичайний темп (переважно витрати), тож після разового поповнення лінія йде вниз.
  const nets = series.map((s) => (s.income - s.spend) / 100).sort((a, b) => a - b);
  const mid = Math.floor(nets.length / 2);
  const slope = nets.length % 2 ? nets[mid] : (nets[mid - 1] + nets[mid]) / 2;
  rows[rows.length - 1].proj = lastCum; // місток від фактичної точки до пунктиру
  const d = new Date(opts.to * 1000);
  const dm = dateFmt({ day: "numeric", month: "numeric" });
  for (let i = 1; i <= remaining; i++) {
    d.setDate(d.getDate() + 1);
    rows.push({ label: dm.format(d).replace(/\s/g, ""), cum: null, proj: Math.round(lastCum + slope * i) });
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
  const daily = series.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.bucket));
  if (daily.length < 4) return null;

  const byWeekday = new Array(7).fill(0) as number[];
  let weekdaySum = 0, weekendSum = 0;
  for (const s of daily) {
    const d = new Date(s.bucket + "T00:00:00");
    const wd = d.getDay();
    byWeekday[wd] += s.spend;
    if (wd === 0 || wd === 6) weekendSum += s.spend; else weekdaySum += s.spend;
  }
  const wdMax = Math.max(...byWeekday, 1);
  const topWd = byWeekday.indexOf(Math.max(...byWeekday));
  const total = weekdaySum + weekendSum || 1;
  const weekendPct = Math.round((weekendSum / total) * 100);

  // §1b: найдорожчий день + скільки днів без витрат за період.
  const priciest = daily.reduce<Overview["series"][number] | null>((m, s) => (s.spend > (m?.spend ?? -1) ? s : m), null);
  const totalDays = Math.max(1, Math.round((to - from) / 86400));
  const noSpendDays = Math.max(0, totalDays - daily.filter((s) => s.spend > 0).length);

  // §1: heat-map — сума витрат за числом місяця (1..31), щоб видно було «дорогі» дати (зарплата, оренда).
  const byDom = new Array(31).fill(0) as number[];
  for (const s of daily) { const dom = Number(s.bucket.split("-")[2]); if (dom >= 1 && dom <= 31) byDom[dom - 1] += s.spend; }
  const domMax = Math.max(...byDom, 1);
  const hasDom = byDom.some((v) => v > 0);

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
            {byWeekday.map((v, i) => (
              <HoverTip key={i} content={
                <><div className="tip-lbl">{weekdayLong(i)}</div>
                <div className="r">{formatMinor(v, { decimals: false })} {sign}</div>
                <div className="r" style={{ color: "rgba(255,255,255,0.6)" }}>{Math.round((v / total) * 100)}{t("stats.patterns.pctOfPeriod")}</div></>
              }>
                <button type="button" className={`wd-col ${openWd === i ? "open" : ""}`}
                  onClick={() => setOpenWd(openWd === i ? null : i)}>
                  {/* scaleY замість height (layout-thrash). Мінімум 0.02 — щоб дуже малий
                      день лишався видимим: min-height трансформ не рятує. */}
                  <div className="wd-bar-wrap"><div className="wd-bar" style={{ transform: `scaleY(${Math.max(0.02, v / wdMax)})`, background: i === topWd || i === openWd ? "var(--accent)" : "var(--line-strong)" }} /></div>
                  <span className="wd-lbl">{weekdayShort(i)}</span>
                </button>
              </HoverTip>
            ))}
          </div>
          <p className="deep-desc">{t("stats.patterns.topWdDesc", { weekday: weekdayLong(topWd), amount: formatMinor(byWeekday[topWd], { decimals: false }), sign })}</p>
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
            {byDom.map((v, i) => {
              const intensity = v > 0 ? 0.15 + 0.85 * (v / domMax) : 0;
              const dom = i + 1;
              return (
                <HoverTip key={i} content={<><div className="tip-lbl">{t("stats.patterns.domTip", { dom })}</div><div className="r">{formatMinor(v, { decimals: false })} {sign}</div></>}>
                  <button type="button" className={`dom-cell ${openDom === dom ? "open" : ""}`} disabled={!(v > 0)}
                    onClick={() => setOpenDom((o) => (o === dom ? null : dom))}
                    style={{ background: v > 0 ? `color-mix(in srgb, var(--accent) ${Math.round(intensity * 100)}%, transparent)` : "var(--surface-2)" }}>
                    <span className="dom-num" style={{ color: intensity > 0.55 ? "#fff" : "var(--muted)" }}>{dom}</span>
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
          <p className="deep-desc">{t("stats.patterns.domDesc")}</p>
        </div>
      )}
    </section>
  );
}
