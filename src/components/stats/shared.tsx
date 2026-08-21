/**
 * Pieces the Statistics tabs share.
 *
 * Split out of `src/pages/Stats.tsx` on 2026-08-08. That file was 1 379 lines — the largest in the
 * project — and it had stopped being a page: it was five pages sharing a header. The cut follows
 * the TABS, because that is the boundary the user already sees and the one that decides what is
 * on screen; any other cut would have produced files nobody could name.
 *
 * `Stats.tsx` keeps what all five genuinely share: the period, the currency, the one
 * `/analytics/overview` request they all read. Everything a single tab owns lives here.
 */

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useT, translate } from "../../i18n/index.ts";
import { getLocale, dateFmt } from "../../i18n/locale.ts";
import { formatMinor, monthShort } from "../../lib/format.ts";
import { useGetSliceDrillQuery } from "../../store/api.ts";
import type { CompareRow, DrillTx } from "../../store/api.ts";
import { TxItem } from "../transactions/TxItem.tsx";
import { SkeletonRows } from "../ui/Skeleton.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";

/**
 * The period presets, shared by the shell and by `calPeriods` in the Categories tab.
 *
 * One copy on purpose: two would be two definitions of what "quarter" means, and the tabs would
 * disagree about the same money without anything failing.
 */
export const RANGES = {
  week: { labelKey: "stats.range.week", days: 7 },
  month: { labelKey: "stats.range.month", days: 30 },
  quarter: { labelKey: "stats.range.quarter", days: 90 },
  year: { labelKey: "stats.range.year", days: 365 },
} as const;
export type RangeKey = keyof typeof RANGES;


// currency=null → зведено в ₴. Знак завжди по обраній валюті (₴ для зведення).
export type Cur = number | null;
// The merged comparison row and the movers come from the server whole (§CADENCE): the two tabs
// used to build them here, twice, and neither copy could see the charge counts that decide
// whether a delta means anything. Re-exported under the old names so the tabs read the same.
export type MoverRow = CompareRow;
export type Movers = { up: CompareRow[]; down: CompareRow[] };

export const FALLBACK = ["#1f6e4c", "#2e6be6", "#7a3e9d", "#c9871a", "#b23a2e", "#127c86", "#6b7a74"];

// Localized short weekday names (0=Sun..6=Sat). Used both as tooltips and inline labels
// in deeper-analytics charts; keeps the live locale in sync.
export function weekdayShort(idx: number): string {
  return dateFmt({ weekday: "short" }).format(new Date(2021, 0, 3 + idx));
}
export function weekdayLong(idx: number): string {
  return dateFmt({ weekday: "long" }).format(new Date(2021, 0, 3 + idx));
}

export function labelFor(bucket: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) { const [, m, d] = bucket.split("-"); return `${d}.${m}`; }
  if (/^\d{4}-W\d+$/.test(bucket)) return translate(getLocale(), "stats.weekAbbr") + bucket.split("-W")[1];
  if (/^\d{4}-\d{2}$/.test(bucket)) return monthShort(Number(bucket.split("-")[1]) - 1) ?? bucket;
  return bucket;
}

// Localized full month name (0=Jan..11=Dec) for month-comparison labels.
export function monthLong(monthIndex0: number): string {
  return dateFmt({ month: "long" }).format(new Date(2021, monthIndex0, 1));
}

// Розбивка по категоріях із drill-down (клік → підкатегорії + мерчанти) і винесенням
// «Перекази і зняття» як вторинної (§F2 крок 1 — не роздуває основний розподіл).
export const isSecondaryCat = (name: string | null) => /переказ|зняття/i.test(name ?? "");

// §R2-ST5(в): спільний список операцій зрізу з переходом на /tx/:id.
// §1: дрил-операції = стандартний рядок транзакції (спільний TxItem), лише компактніший.
// §1: підзаголовок «що саме рахується» — щоб цифра зрізу була прозорою (канон stats.ts).
export const DRILL_NOTE: Record<"expense" | "income", "stats.drill.drillNoteExpense" | "stats.drill.drillNoteIncome"> = {
  expense: "stats.drill.drillNoteExpense",
  income: "stats.drill.drillNoteIncome",
};
export function DrillTxList({ txs, kind = "expense" }: { txs: DrillTx[]; kind?: "expense" | "income" }) {
  const t = useT();
  return (
    <>
      <div className="drill-note muted">{t(DRILL_NOTE[kind])}</div>
      <div className="ledger rows drill-txs">
        {txs.map((t) => (
          <TxItem key={t.id} t={t} compact />
        ))}
      </div>
    </>
  );
}

// §R2-ST5(б): drill зрізу — підсумок + операції. dim=all → увесь період (клік по KPI).
export function SliceDrillPanel({ dim, value, type, from, to, currency, sign, embedded }: {
  dim: "merchant" | "account" | "event" | "weekday" | "day" | "dom" | "importance" | "all"; value?: string; type?: "expense" | "income";
  from: number; to: number; currency: Cur; sign: string; embedded?: boolean;
}) {
  const t = useT();
  const { data, isFetching } = useGetSliceDrillQuery({ dim, value, type, from, to, currency, limit: dim === "all" ? 300 : 60 });
  if (isFetching) return <div className={embedded ? "" : "cat-drill"}><SkeletonRows n={5} /></div>;
  if (!data) return null;
  if (!data.transactions.length) return <div className="cat-drill"><span className="muted" style={{ fontSize: 12.5 }}>{t("stats.drill.noTx")}</span></div>;
  const cap = dim === "all" ? 300 : 60;
  return (
    <div className={embedded ? "" : "cat-drill"}>
      <div className="cat-drill-block cat-drill-txs" style={{ borderTop: "none", paddingTop: 0 }}>
        <div className="label">
          {t("stats.catdrill.txs", { count: data.n, plus: data.n >= cap ? "+" : "", total: formatMinor(data.spent, { decimals: false }), sign })}
          {dim === "event" && value != null && <Link to={`/events/${value}`} className="drill-open-link">{t("stats.drill.openEvent")}</Link>}
        </div>
        <DrillTxList txs={data.transactions} kind={type === "income" ? "income" : "expense"} />
      </div>
    </div>
  );
}

// Порівняння вибраного періоду з попереднім рівним (беклог). Обчислювана аналітика.
export function deltaPct(a: number, b: number): number {
  if (b > 0) return Math.round(((a - b) / b) * 100);
  return a > 0 ? 100 : 0;
}

// `goodUp` — для рядків, де зростання ДОБРЕ (надходження). Міняє лише КОЛІР, не число:
// підмінити місцями a/b було б простіше, але тоді «+20% доходу» показалось би як «−20%».
//
// `meaningful={false}` — §CADENCE. The percentage is still shown, because it is the true
// arithmetic and hiding it would leave a hole where money moved; what goes away is the COLOUR.
// Red and green are the part that makes a claim, and «підписки −92%» in green is the app
// congratulating someone for the 1st of the month landing in the other window. Neutral chip
// plus a `title` that says why is the honest version — same decision as `newLabel`/`goneLabel`,
// which also refuse to dress a calendar fact as a trend.
export function DeltaChip({ a, b, goodUp, meaningful = true }: { a: number; b: number; goodUp?: boolean; meaningful?: boolean }) {
  const t = useT();
  if (a === b) return <span className="cmp-delta flat">0%</span>;
  // §R2-ST2(а): 0→X — не «+100%» (вводить в оману), а «новий»; X→0 — «зникло».
  const grew = a > b;
  if (b === 0 && a > 0) return <span className={`cmp-delta ${goodUp ? "down" : "up"}`}>{t("stats.compare.newLabel")}</span>;
  if (a === 0 && b > 0) return <span className={`cmp-delta ${goodUp ? "up" : "down"}`}>{t("stats.compare.goneLabel")}</span>;
  const p = deltaPct(a, b);
  if (!meaningful) {
    return <span className="cmp-delta timing" title={t("stats.compare.cadenceHint")}>{p > 0 ? "+" : ""}{p}%</span>;
  }
  // Для витрат зростання — «погано» (червоне), спад — «добре» (зелене). Для доходу — навпаки.
  const cls = grew === !goodUp ? "up" : "down";
  return <span className={`cmp-delta ${cls}`}>{p > 0 ? "+" : ""}{p}%</span>;
}

// Заголовок дрібного факту (stat-facts) з опційним поясненням.
export function FactLabel({ children, info }: { children: ReactNode; info?: ReactNode }) {
  return (
    <span className="fact-label-row">
      <span className="fact-label">{children}</span>
      {info && <InfoTip>{info}</InfoTip>}
    </span>
  );
}

// Вміст KPI-плитки (без обгортки card — обгортає викликач: card або button).
export function StatKpiInner({ title, minor, prev, sign, goodWhenUp, tone, info }: {
  title: string; minor: number; prev?: number; sign: string; goodWhenUp?: boolean; tone?: "pos" | "neg"; info?: ReactNode;
}) {
  const t = useT();
  let deltaPct: number | null = null;
  if (prev != null && prev > 0) deltaPct = ((minor - prev) / prev) * 100;
  const up = (deltaPct ?? 0) >= 0;
  const good = up === !!goodWhenUp;
  return (
    <>
      <div className="kpi-head-row">
        <span className="kpi-title">{title}</span>
        {info && <span className="kpi-info"><InfoTip>{info}</InfoTip></span>}
      </div>
      <div className={`kpi-num num-hero ${tone ?? ""}`}>
        {formatMinor(minor, { decimals: false })}<span className="cur">{sign}</span>
      </div>
      {deltaPct !== null ? (
        <div className="kpi-foot">
          <span className={`delta ${good ? "up" : "down"}`}>{up ? "↑" : "↓"} {Math.abs(deltaPct).toFixed(1)}%</span>
          <span>{t("stats.kpi.vsPrev")}</span>
        </div>
      ) : (
        <div className="kpi-foot"><span>{t("stats.kpi.forPeriod")}</span></div>
      )}
    </>
  );
}
