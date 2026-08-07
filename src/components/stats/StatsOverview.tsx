/**
 * Statistics → Overview: the headline numbers and what they are made of.
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
import { useGetPatternsQuery } from "../../store/api.ts";
import type { Overview } from "../../store/api.ts";
import { IMPORTANCE_LEVELS, IMPORTANCE_META, type Importance } from "../../lib/importance.ts";
import { HoverTip } from "../ui/HoverTip.tsx";
import { SliceDrillPanel, StatKpiInner, type Cur } from "./shared.tsx";

// Клікабельні KPI: клік на «Витрати»/«Надходження» → повний список операцій, що рахуються.
export function ClickableKpis({ data, sign, net, avgDay, from, to, currency }: {
  data: Overview; sign: string; net: number; avgDay: number; from: number; to: number; currency: Cur;
}) {
  const t = useT();
  const [open, setOpen] = useState<"expense" | "income" | null>(null);
  return (
    <>
      <div className="stat-kpis">
        <button type="button" className={`card kpi-tile kpi-click ${open === "expense" ? "open" : ""}`} onClick={() => setOpen(open === "expense" ? null : "expense")}>
          <StatKpiInner title={t("stats.kpi.spend")} minor={data.summary.spend} prev={data.prev.spend} sign={sign} goodWhenUp={false}
            info={<>{t("stats.kpi.spendInfo")}</>} />
        </button>
        <button type="button" className={`card kpi-tile kpi-click ${open === "income" ? "open" : ""}`} onClick={() => setOpen(open === "income" ? null : "income")}>
          <StatKpiInner title={t("stats.kpi.income")} minor={data.summary.income} prev={data.prev.income} sign={sign} goodWhenUp
            info={<>{t("stats.kpi.incomeInfo")}</>} />
        </button>
        <div className="card kpi-tile">
          <StatKpiInner title={t("stats.kpi.net")} minor={net} sign={sign} tone={net >= 0 ? "pos" : "neg"}
            info={<>{t("stats.kpi.netInfo")}</>} />
        </div>
        <div className="card kpi-tile">
          <StatKpiInner title={t("stats.kpi.avgDay")} minor={avgDay} sign={sign}
            info={<>{t("stats.kpi.avgDayInfo")}</>} />
        </div>
      </div>
      {open && (
        <div className="card drill-open-card">
          <div className="label" style={{ marginBottom: 6 }}>
            {(open === "expense" ? t("stats.drill.allSpend") : t("stats.drill.allIncome")) + " " + t("stats.drill.period")}
          </div>
          <SliceDrillPanel dim="all" type={open} from={from} to={to} currency={currency} sign={sign} embedded />
        </div>
      )}
    </>
  );
}

export function ImportanceBreakdown({ data, sign, from, to, currency }: { data: Overview; sign: string; from: number; to: number; currency: Cur }) {
  const t = useT();
  const rows = data.byImportance ?? [];
  const total = rows.reduce((s, r) => s + Math.abs(r.spent), 0);
  const [open, setOpen] = useState<Importance | null>(null);
  if (!total) return null;
  const byLevel = (lv: string) => Math.abs(rows.find((r) => r.importance === lv)?.spent ?? 0);
  return (
    <section>
      <div className="section-head">
        <h2>{t("stats.importance.title")}</h2>
        <HoverTip content={<>{t("stats.importance.tip")}</>}>
          <span className="label">{t("stats.importance.sub")}</span>
        </HoverTip>
      </div>
      <div className="card" style={{ padding: 18 }}>
        <div className="imp-bar imp-bar-lg">
          {IMPORTANCE_LEVELS.map((lv) => {
            const v = byLevel(lv);
            if (!v) return null;
            const pct = Math.round((v / total) * 100);
            return (
              <span key={lv} style={{ width: `${(v / total) * 100}%`, background: IMPORTANCE_META[lv].color }} title={`${t(IMPORTANCE_META[lv].labelKey)}: ${pct}%`}>
                {pct >= 8 && <span className="imp-seg-lbl">{pct}%</span>}
              </span>
            );
          })}
        </div>
        <div className="imp-cards">
          {IMPORTANCE_LEVELS.map((lv) => {
            const v = byLevel(lv);
            const pct = Math.round((v / total) * 100);
            return (
              <button type="button" key={lv} className={`imp-card fact-click ${open === lv ? "open" : ""}`}
                disabled={!v} onClick={() => setOpen((o) => (o === lv ? null : lv))}>
                <span className="imp-card-top"><span className="d" style={{ background: IMPORTANCE_META[lv].color }} />{t(IMPORTANCE_META[lv].labelKey)} ›</span>
                <span className="imp-card-amt num-hero">{formatMinor(v, { decimals: false })} {sign}</span>
                <span className="imp-card-pct muted">{pct}{t("stats.importance.ofSpend")}</span>
              </button>
            );
          })}
        </div>
        {open && byLevel(open) > 0 && (
          <div className="drill-open-card" style={{ marginTop: 12 }}>
            <div className="label" style={{ marginBottom: 6 }}>{t("stats.importance.drill", { label: t(IMPORTANCE_META[open].labelKey) })}</div>
            <SliceDrillPanel dim="importance" value={open} from={from} to={to} currency={currency} sign={sign} embedded />
          </div>
        )}
      </div>
    </section>
  );
}

// §6: смуга частки витрат за вагомістю (обов'язкові / бажані / необов'язкові).
// §E1/E2/E3: детерміновані патерни витрат цього місяця (без AI).
export function SpendingPatterns() {
  const t = useT();
  const { data } = useGetPatternsQuery();
  if (!data) return null;
  const { recurring, anomalies, pace } = data;
  const reg = recurring.recurring.spent;
  const one = recurring.oneoff.spent;
  const tot = reg + one;
  const dfmt = dateFmt({ day: "2-digit", month: "short" });
  const hasAny = tot > 0 || anomalies.length > 0 || pace.length > 0;
  if (!hasAny) return null;

  return (
    <>
      {tot > 0 && (
        <section>
          <div className="section-head">
            <h2>{t("stats.recurring.title")}</h2>
            <HoverTip content={<>{t("stats.recurring.tip")}</>}>
              <span className="label">{t("stats.recurring.sub")}</span>
            </HoverTip>
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div className="split-bar">
              {reg > 0 && <span style={{ width: `${(reg / tot) * 100}%`, background: "var(--accent)" }} title={t("stats.recurring.titleReg", { pct: Math.round((reg / tot) * 100) })} />}
              {one > 0 && <span style={{ width: `${(one / tot) * 100}%`, background: "var(--c-teal)" }} title={t("stats.recurring.titleOne", { pct: Math.round((one / tot) * 100) })} />}
            </div>
            <div className="imp-legend">
              <span className="lg"><span className="d" style={{ background: "var(--accent)" }} />{t("stats.recurring.regularLabel")} · <b>{formatMinor(reg, { decimals: false })} ₴</b> <span className="muted">({recurring.recurring.n} {t("stats.txCountShort")})</span></span>
              <span className="lg"><span className="d" style={{ background: "var(--c-teal)" }} />{t("stats.recurring.oneoffLabel")} · <b>{formatMinor(one, { decimals: false })} ₴</b> <span className="muted">({recurring.oneoff.n} {t("stats.txCountShort")})</span></span>
            </div>
            {recurring.oneoff_items.length > 0 && (
              <div className="oneoff-list">
                <div className="label" style={{ marginBottom: 6 }}>{t("stats.recurring.topOneoff")}</div>
                {recurring.oneoff_items.map((it, i) => (
                  <div key={i} className="oneoff-row">
                    <span className="oor-name">{it.merchant ?? it.category ?? t("stats.recurring.fallback")}</span>
                    <span className="oor-cat muted">{it.category ?? "—"}</span>
                    <span className="oor-date muted">{dfmt.format(it.time * 1000)}</span>
                    <span className="oor-amt num-mono">{formatMinor(it.amount, { decimals: false })} ₴</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {anomalies.length > 0 && (
        <section>
          <div className="section-head">
            <h2>{t("stats.anomaly.title")}</h2>
            <HoverTip content={<>{t("stats.anomaly.tip")}</>}>
              <span className="label">{t("common.whatIsThis")}</span>
            </HoverTip>
          </div>
          <div className="card" style={{ padding: 8 }}>
            {anomalies.map((a, i) => (
              <div key={i} className="anomaly warn">
                <span className="an-dot" style={{ background: a.color ?? undefined }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{a.category}</b>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {t("stats.anomaly.desc", { projected: formatMinor(a.projected, { decimals: false }), usual: formatMinor(a.usual, { decimals: false }) })}
                  </div>
                </div>
                {a.pct != null && <span className="cmp-delta up">+{a.pct - 100}%</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {pace.length > 0 && (
        <section>
          <div className="section-head">
            <h2>{t("stats.pace.title")}</h2>
            <HoverTip content={<>{t("stats.pace.tip")}</>}>
              <span className="label">{t("stats.pace.sub")}</span>
            </HoverTip>
          </div>
          <div className="card" style={{ padding: 8 }}>
            {pace.map((p, i) => (
              <div key={i} className="pace-row">
                <span className="pace-name">
                  <span className="d" style={{ background: p.color ?? "var(--accent)" }} />{p.category}
                  {(p.mostly_oneoff || p.lumpy) && <span className="pace-tag" title={t("stats.pace.lumpyTitle")}>{t("stats.pace.lumpyTag")}</span>}
                </span>
                <span className="pace-nums num-mono">
                  {formatMinor(p.spent, { decimals: false })} → <b>≈{formatMinor(p.projected, { decimals: false })}</b> ₴
                  <span className="muted"> / {formatMinor(p.usual, { decimals: false })}</span>
                </span>
                {p.pct != null && (
                  <span className={`cmp-delta ${p.pct > 115 ? "up" : p.pct < 85 ? "down" : "flat"}`}>{p.pct}%</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
