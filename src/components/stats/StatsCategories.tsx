/**
 * Statistics → Categories: where the money went, and how that compares.
 *
 * Split out of `src/pages/Stats.tsx` on 2026-08-08. That file was 1 379 lines — the largest in the
 * project — and it had stopped being a page: it was five pages sharing a header. The cut follows
 * the TABS, because that is the boundary the user already sees and the one that decides what is
 * on screen; any other cut would have produced files nobody could name.
 *
 * `Stats.tsx` keeps what all five genuinely share: the period, the currency, the one
 * `/analytics/overview` request they all read. Everything a single tab owns lives here.
 */

import { useMemo, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { formatMinor, formatDate } from "../../lib/format.ts";
import {
  useGetCategoryDrillQuery, useGetCompareQuery, useGetSparkQuery, useGetTransfersStatusQuery,
} from "../../store/api.ts";
import type { Overview } from "../../store/api.ts";
import { TransferReviewModal } from "../transactions/TransferReviewModal.tsx";
import { Sparkline } from "../ui/Sparkline.tsx";
import { SkeletonRows } from "../ui/Skeleton.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { HoverTip } from "../ui/HoverTip.tsx";
import { Icon } from "../ui/Icon.tsx";
import {
  DeltaChip, DrillTxList, FALLBACK, RANGES, isSecondaryCat, type Cur, type Movers, type RangeKey,
} from "./shared.tsx";

export function CategoryBreakdown({ rows, from, to, currency, sign }: {
  rows: Overview["byCategory"]; from: number; to: number; currency: Cur; sign: string;
}) {
  const t = useT();
  const [openId, setOpenId] = useState<number | null>(null);
  const { data: spark } = useGetSparkQuery();
  const primary = rows.filter((r) => !isSecondaryCat(r.category_name));
  const secondary = rows.filter((r) => isSecondaryCat(r.category_name));
  const total = primary.reduce((a, c) => a + c.spent, 0) || 1;
  const noCat = t("common.uncategorized");

  const bar = (e: Overview["byCategory"][number], i: number, secondaryStyle: boolean) => {
    const p = (e.spent / total) * 100;
    const color = secondaryStyle ? "var(--muted)" : (e.color ?? FALLBACK[i % FALLBACK.length]);
    const id = e.category_id;
    const open = openId != null && openId === id;
    return (
      <div key={`${id}-${i}`}>
        <HoverTip content={
          <><div className="tip-lbl">{e.category_name ?? noCat}</div>
          <div className="r"><span className="d" style={{ background: color }} />{formatMinor(e.spent, { decimals: false })} {sign}</div>
          <div className="r" style={{ color: "rgba(255,255,255,0.6)" }}>{p.toFixed(0)}% · {e.n} {t("stats.txCountShort")} · {t("stats.avgShort")} {formatMinor(Math.round(e.spent / Math.max(1, e.n)), { decimals: false })} {sign}</div></>
        }>
          <button type="button" className={`catbar catbar-btn ${open ? "open" : ""}`}
            onClick={() => id != null && setOpenId(open ? null : id)}>
            <span className="cb-name"><span className="d" style={{ background: color }} />{e.category_name ?? noCat}</span>
            <span className="cb-track"><span className="cb-fill" style={{ width: `${Math.min(p, 100)}%`, background: color }} /></span>
            {id != null && spark?.categories[String(id)] && <Sparkline values={spark.categories[String(id)]} color={color} />}
            <span className="cb-val">{formatMinor(e.spent, { decimals: false })} {sign}</span>
            <span className="cb-pct">{p.toFixed(0)}%</span>
          </button>
        </HoverTip>
        {open && id != null && <CatDrill category={id} from={from} to={to} currency={currency} sign={sign} />}
      </div>
    );
  };

  return (
    <div className="card flush"><div className="catbars">
      {primary.slice(0, 9).map((e, i) => bar(e, i, false))}
      {secondary.length > 0 && (
        <div className="cat-secondary">
          <SecondaryHeader />
          {secondary.map((e, i) => bar(e, i, true))}
        </div>
      )}
    </div></div>
  );
}

// Заголовок вторинного блоку: кнопка AI-розмітки реальної категорії переказів/знять (§F2 крок 2).
export function SecondaryHeader() {
  const t = useT();
  const { data: status } = useGetTransfersStatusQuery();
  const [showReview, setShowReview] = useState(false);
  const pending = status?.pending ?? 0;

  return (
    <>
      <div className="cat-ai-callout">
        <div className="cat-ai-body">
          <div className="cat-ai-title"><Icon name="spark" size={15} /> {t("stats.secondary.title")}</div>
          <div className="cat-ai-sub">
            {pending > 0
              ? t("stats.secondary.pending", { count: pending })
              : t("stats.secondary.done")}
          </div>
        </div>
        <button type="button" className="btn primary cat-ai-btn" onClick={() => setShowReview(true)}>
          {pending > 0 && <Icon name="spark" size={15} />}
          {pending > 0 ? t("stats.secondary.reviewBtn") : t("stats.secondary.reviewBtnDone")}
        </button>
      </div>
      {showReview && <TransferReviewModal onClose={() => setShowReview(false)} />}
    </>
  );
}

export function CatDrill({ category, from, to, currency, sign }: { category: number; from: number; to: number; currency: Cur; sign: string }) {
  const t = useT();
  const { data, isFetching } = useGetCategoryDrillQuery({ category, from, to, currency });
  if (isFetching) return <div className="cat-drill"><SkeletonRows n={4} /></div>;
  if (!data) return null;
  // Коли в категорії немає власних підкатегорій, сервер повертає один "підкатегорійний"
  // рядок = сама категорія — дублює заголовок бару один-в-один. Ховаємо цей шум.
  const subs = data.subs.length === 1 && data.subs[0].category_id === category ? [] : data.subs;
  const subMax = Math.max(...subs.map((s) => s.spent), 1);
  const mMax = Math.max(...data.merchants.map((m) => m.spent), 1);
  const txs = data.transactions ?? [];
  const txTotal = txs.reduce((a, t) => a + Math.abs(t.amount), 0);
  const hasSubs = subs.length > 0;
  const hasMerch = data.merchants.length > 0;
  return (
    <div className="cat-drill">
      {(hasSubs || hasMerch) && (
        <div className={`cat-drill-grid ${hasSubs && hasMerch ? "" : "single"}`}>
          {hasSubs && (
            <div className="cat-drill-panel">
              <div className="cat-drill-panel-h">{t("stats.catdrill.subs")}</div>
              {subs.map((s, i) => (
                <div key={i} className="drill-row">
                  <span className="drill-name"><span className="d" style={{ background: s.color ?? "var(--muted)" }} />{s.name}</span>
                  <span className="drill-track"><span style={{ width: `${(s.spent / subMax) * 100}%`, background: s.color ?? "var(--muted)" }} /></span>
                  <span className="drill-val">{formatMinor(s.spent, { decimals: false })} {sign}</span>
                </div>
              ))}
            </div>
          )}
          {hasMerch && (
            <div className="cat-drill-panel">
              <div className="cat-drill-panel-h">{t("stats.catdrill.topMerch")}</div>
              {data.merchants.slice(0, 6).map((m, i) => (
                <div key={i} className="drill-row">
                  <span className="drill-name">{m.merchant}</span>
                  <span className="drill-track"><span style={{ width: `${(m.spent / mMax) * 100}%`, background: "var(--accent)" }} /></span>
                  <span className="drill-val">{formatMinor(m.spent, { decimals: false })} {sign}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* §R2-ST5(в): самі операції зрізу з переходом на транзакцію. */}
      {txs.length > 0 && (
        <div className="cat-drill-block cat-drill-txs">
          <div className="label">{t("stats.catdrill.txs", { count: txs.length, plus: txs.length >= 60 ? "+" : "", total: formatMinor(txTotal, { decimals: false }), sign })}</div>
          <DrillTxList txs={txs} />
        </div>
      )}
      {!hasSubs && !hasMerch && !txs.length && <span className="muted" style={{ fontSize: 12.5 }}>{t("stats.drill.noMerch")}</span>}
    </div>
  );
}

// Середній чек по категоріях (spent ÷ n). Відповідає на «де окремі покупки найдорожчі» —
// категорія з малою сумою, але великим чеком (напр. техніка) інакше губиться в загальному топі.
// Клієнтський розрахунок із byCategory (канонічні suми/кількості з overview).
export function AvgCheckByCategory({ rows, sign }: { rows: Overview["byCategory"]; sign: string }) {
  const t = useT();
  const noCat = t("common.uncategorized");
  const items = rows
    .filter((r) => !isSecondaryCat(r.category_name) && r.n > 0 && r.spent > 0)
    .map((r, i) => ({ name: r.category_name ?? noCat, color: r.color ?? FALLBACK[i % FALLBACK.length], avg: Math.round(r.spent / r.n), n: r.n }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 8);
  if (items.length < 2) return null;
  const max = Math.max(...items.map((x) => x.avg), 1);
  return (
    <section>
      <div className="section-head"><h2>{t("stats.avgCheck.title")}</h2><InfoTip>{t("stats.avgCheck.tip")}</InfoTip><span className="label">{t("stats.avgCheck.sub")}</span></div>
      <div className="card flush"><div className="catbars">
        {items.map((it, i) => (
          <div key={i} className="catbar">
            <span className="cb-name"><span className="d" style={{ background: it.color }} />{it.name}</span>
            <span className="cb-track"><span className="cb-fill" style={{ width: `${(it.avg / max) * 100}%`, background: it.color }} /></span>
            <span className="cb-val">{formatMinor(it.avg, { decimals: false })} {sign}</span>
            <span className="cb-pct">{t("stats.avgCheck.nTx", { n: it.n })}</span>
          </div>
        ))}
      </div></div>
    </section>
  );
}

// §D: календарно-вирівняні періоди для чесного порівняння (MTD vs той самий відрізок
// попереднього періоду), а не ковзне вікно 30 днів.
// unitKey — i18n key (not resolved text), so the caller stays reactive to a live language switch.
export type UnitKey = "stats.unit.week" | "stats.unit.month" | "stats.unit.quarter" | "stats.unit.year";
export function calPeriods(range: RangeKey, mode: "calendar" | "rolling"): { curFrom: number; curTo: number; prevFrom: number; prevTo: number; unitKey: UnitKey } {
  const now = new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  if (mode === "rolling") {
    const days = RANGES[range].days;
    const curFrom = nowS - days * 86400;
    const unitKey = ({ week: "stats.unit.week", month: "stats.unit.month", quarter: "stats.unit.quarter", year: "stats.unit.year" } as const)[range];
    return { curFrom, curTo: nowS, prevFrom: curFrom - days * 86400, prevTo: curFrom, unitKey };
  }
  let curStart: Date, prevStart: Date, unitKey: UnitKey;
  if (range === "week") {
    const dow = (now.getDay() + 6) % 7; // Пн=0
    curStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
    prevStart = new Date(curStart); prevStart.setDate(prevStart.getDate() - 7);
    unitKey = "stats.unit.week";
  } else if (range === "month") {
    curStart = new Date(now.getFullYear(), now.getMonth(), 1);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    unitKey = "stats.unit.month";
  } else if (range === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    curStart = new Date(now.getFullYear(), q * 3, 1);
    prevStart = new Date(now.getFullYear(), q * 3 - 3, 1);
    unitKey = "stats.unit.quarter";
  } else {
    curStart = new Date(now.getFullYear(), 0, 1);
    prevStart = new Date(now.getFullYear() - 1, 0, 1);
    unitKey = "stats.unit.year";
  }
  const curFrom = Math.floor(curStart.getTime() / 1000);
  const curTo = nowS;
  const elapsed = curTo - curFrom; // чесний MTD: попередній період беремо такої ж довжини
  const prevFrom = Math.floor(prevStart.getTime() / 1000);
  return { curFrom, curTo, prevFrom, prevTo: prevFrom + elapsed, unitKey };
}

export function PeriodCompare({ range, mode, currency, sign }: {
  range: RangeKey; mode: "calendar" | "rolling"; currency: Cur; sign: string;
}) {
  const t = useT();
  const { curFrom, curTo, prevFrom, prevTo, unitKey } = useMemo(() => calPeriods(range, mode), [range, mode]);
  const { data, isFetching } = useGetCompareQuery({ from: curFrom, to: curTo, currency, bfrom: prevFrom, bto: prevTo });
  const dr = (a: number, b: number) => `${formatDate(a)}–${formatDate(b)}`;
  const noCat = t("common.uncategorized");
  const { rows, rest, movers } = useMemo(() => {
    if (!data) return { rows: [], rest: null as null | { a: number; b: number }, movers: { up: [], down: [] } as Movers };
    const map = new Map<number | null, { name: string; color: string | null; a: number; b: number }>();
    for (const r of data.a.byCategory) map.set(r.category_id, { name: r.category_name ?? noCat, color: r.color, a: r.spent, b: 0 });
    for (const r of data.b.byCategory) {
      const cur = map.get(r.category_id);
      if (cur) cur.b = r.spent;
      else map.set(r.category_id, { name: r.category_name ?? noCat, color: r.color, a: 0, b: r.spent });
    }
    const all = [...map.values()].sort((x, y) => y.a - x.a);
    const top = all.slice(0, 10);
    // §R2-ST2(г): решта категорій згорнута в один рядок, щоб сума рядків збігалася з тоталом.
    const tail = all.slice(10);
    const rest = tail.length
      ? tail.reduce((s, r) => ({ a: s.a + r.a, b: s.b + r.b }), { a: 0, b: 0 })
      : null;
    // §1b: топ-рухи — найбільша зміна ₴ vs минулий (поріг 50₴, щоб відсіяти шум).
    const deltas = [...map.values()].map((r) => ({ ...r, delta: r.a - r.b })).filter((r) => Math.abs(r.delta) >= 5000);
    const up = deltas.filter((r) => r.delta > 0).sort((x, y) => y.delta - x.delta).slice(0, 3);
    const down = deltas.filter((r) => r.delta < 0).sort((x, y) => x.delta - y.delta).slice(0, 3);
    return { rows: top, rest, movers: { up, down } as Movers };
  }, [data, noCat]);

  if (isFetching || !data) return null;
  if (!data.a.spend && !data.b.spend) return null;

  return (
    <section>
      <div className="section-head">
        <h2>{t("stats.compare.title")}</h2>
        <span className="label">{t("stats.compare.sub", { unit: t(unitKey), cur: dr(curFrom, curTo), prev: dr(prevFrom, prevTo) })}</span>
      </div>

      {(movers.up.length > 0 || movers.down.length > 0) && (
        <div className="movers">
          <div className="mv-col">
            <div className="mv-head up">{t("stats.compare.moversUp")}</div>
            {movers.up.length ? movers.up.map((r, i) => (
              <div key={i} className="mv-row">
                <span className="mv-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.name}</span>
                <span className="mv-delta up">+{formatMinor(r.delta, { decimals: false })} {sign}</span>
              </div>
            )) : <div className="mv-empty">{t("stats.compare.moversEmpty")}</div>}
          </div>
          <div className="mv-col">
            <div className="mv-head down">{t("stats.compare.moversDown")}</div>
            {movers.down.length ? movers.down.map((r, i) => (
              <div key={i} className="mv-row">
                <span className="mv-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.name}</span>
                <span className="mv-delta down">−{formatMinor(-r.delta, { decimals: false })} {sign}</span>
              </div>
            )) : <div className="mv-empty">{t("stats.compare.moversEmptyDown")}</div>}
          </div>
        </div>
      )}

      <div className="card cmp-card">
        <div className="cmp-head">
          <div className="cmp-col-h prev">{t("stats.compare.colPrev")}</div>
          <div className="cmp-col-h cur">{t("stats.compare.colCur")}</div>
          <div className="cmp-col-h" />
        </div>
        <div className="cmp-row cmp-total">
          <span className="cmp-name">{t("stats.compare.totalSpend")}</span>
          <span className="cmp-b">{formatMinor(data.b.spend, { decimals: false })} {sign}</span>
          <span className="cmp-a">{formatMinor(data.a.spend, { decimals: false })} {sign}</span>
          <DeltaChip a={data.a.spend} b={data.b.spend} />
        </div>
        {rows.map((r, i) => (
          <HoverTip key={i} content={
            <><div className="tip-lbl">{r.name}</div>
            <div className="r">{t("stats.compare.drillPrev", { amount: formatMinor(r.b, { decimals: false }), sign })}</div>
            <div className="r">{t("stats.compare.drillCur", { amount: formatMinor(r.a, { decimals: false }), sign })}</div></>
          }>
            <div className="cmp-row">
              <span className="cmp-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.name}</span>
              <span className="cmp-b">{formatMinor(r.b, { decimals: false })} {sign}</span>
              <span className="cmp-a">{formatMinor(r.a, { decimals: false })} {sign}</span>
              <DeltaChip a={r.a} b={r.b} />
            </div>
          </HoverTip>
        ))}
        {rest && (rest.a > 0 || rest.b > 0) && (
          <div className="cmp-row" title={t("stats.compare.tipOther")}>
            <span className="cmp-name"><span className="d" style={{ background: "var(--muted)" }} />{t("stats.compare.otherCats")}</span>
            <span className="cmp-b">{formatMinor(rest.b, { decimals: false })} {sign}</span>
            <span className="cmp-a">{formatMinor(rest.a, { decimals: false })} {sign}</span>
            <DeltaChip a={rest.a} b={rest.b} />
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>{t("stats.compare.excludedNote")}</p>
      </div>
    </section>
  );
}
