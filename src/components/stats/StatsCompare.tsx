/**
 * Statistics → Compare: one month against another.
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
import { formatMinor } from "../../lib/format.ts";
import { useGetCompareQuery } from "../../store/api.ts";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { Select } from "../ui/Select.tsx";
import { DeltaChip, monthLong, type Cur, type MoverRow, type Movers } from "./shared.tsx";

// ---- Порівняння двох ДОВІЛЬНИХ місяців (таб «Порівняння») --------------------
// `PeriodCompare` вище прибитий до «цей період проти минулого». Тут місяці обирає
// користувач — «а що змінилось із березня?». Бекенд той самий `/analytics/compare`
// (він від початку приймає дві незалежні пари меж), тож канон і фільтри спільні.
/** Межі календарного місяця за зсувом назад від поточного. */
export function monthBounds(back: number): { from: number; to: number; label: string; y: number; m: number } {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  const from = Math.floor(d.getTime() / 1000);
  const to = Math.floor(new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).getTime() / 1000);
  return { from, to, label: `${monthLong(d.getMonth())} ${d.getFullYear()}`, y: d.getFullYear(), m: d.getMonth() };
}

export function MonthCompare({ currency, sign }: { currency: Cur; sign: string }) {
  const t = useT();
  const noCat = t("common.uncategorized");
  const [aBack, setABack] = useState(0);   // A = пізніший місяць (за замовчуванням поточний)
  const [bBack, setBBack] = useState(1);   // B = база порівняння
  const options = useMemo(
    () => Array.from({ length: 24 }, (_, i) => ({ value: i, label: monthBounds(i).label })),
    [],
  );
  const A = useMemo(() => monthBounds(aBack), [aBack]);
  const B = useMemo(() => monthBounds(bBack), [bBack]);

  const { data, isFetching, error, refetch } = useGetCompareQuery({
    from: A.from, to: A.to, currency, bfrom: B.from, bto: B.to,
  });

  // The merge, the sort and the movers arrive ready (§CADENCE) — this tab only decides how many
  // rows fit. Both of those jobs used to live here, in a copy shared with `PeriodCompare`.
  const { rows, rest } = useMemo(() => {
    if (!data) return { rows: [] as MoverRow[], rest: null as null | { a: number; b: number } };
    const tail = data.rows.slice(12);
    return {
      rows: data.rows.slice(0, 12),
      rest: tail.length ? tail.reduce((s, r) => ({ a: s.a + r.a, b: s.b + r.b }), { a: 0, b: 0 }) : null,
    };
  }, [data]);
  const movers: Movers = data?.movers ?? { up: [], down: [] };

  const sameMonth = A.y === B.y && A.m === B.m;
  // ⚠️ Поточний місяць ще не завершився — порівнювати його з повним місяцем нечесно.
  // Не ховаємо дані (користувач свідомо обрав), але кажемо це прямо, як у прогнозах.
  const now = new Date();
  const partial = [A, B].filter((x) => x.y === now.getFullYear() && x.m === now.getMonth());
  const elapsedDays = now.getDate();
  const monthDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  return (
    <section>
      <div className="section-head">
        <h2>{t("stats.compareMonth.title")}</h2>
        <span className="label">{t("stats.compareMonth.sub")}</span>
      </div>

      <div className="mc-pickers">
        <label className="mc-pick">
          <span className="label">{t("stats.compareMonth.base")}</span>
          <Select value={bBack} options={options} onChange={(v) => setBBack(Number(v))} searchable />
        </label>
        <span className="mc-vs" aria-hidden="true">{t("stats.compareMonth.vs")}</span>
        <label className="mc-pick">
          <span className="label">{t("stats.compareMonth.cur")}</span>
          <Select value={aBack} options={options} onChange={(v) => setABack(Number(v))} searchable />
        </label>
      </div>

      <ErrorNote error={error} what={t("stats.compareMonth.error")} onRetry={refetch} />

      {sameMonth && <div className="card empty">{t("stats.compareMonth.sameMonth")}</div>}

      {!sameMonth && partial.length > 0 && (
        <p className="mc-note">
          {t("stats.compareMonth.partial", { month: monthLong(now.getMonth()), elapsed: elapsedDays, total: monthDays })}
        </p>
      )}

      {!sameMonth && data && !isFetching && !data.a.spend && !data.b.spend && (
        <div className="card empty">{t("stats.compareMonth.empty")}</div>
      )}

      {!sameMonth && data && (data.a.spend > 0 || data.b.spend > 0) && (
        <>
          {(movers.up.length > 0 || movers.down.length > 0) && (
            <div className="movers">
              <div className="mv-col">
                <div className="mv-head up">{t("stats.compare.moversUp")}</div>
                {movers.up.length ? movers.up.map((r, i) => (
                  <div key={i} className="mv-row">
                    <span className="mv-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.category_name ?? noCat}</span>
                    <span className="mv-delta up">+{formatMinor(r.delta, { decimals: false })} {sign}</span>
                  </div>
                )) : <div className="mv-empty">{t("stats.compare.moversEmpty")}</div>}
              </div>
              <div className="mv-col">
                <div className="mv-head down">{t("stats.compare.moversDown")}</div>
                {movers.down.length ? movers.down.map((r, i) => (
                  <div key={i} className="mv-row">
                    <span className="mv-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.category_name ?? noCat}</span>
                    <span className="mv-delta down">−{formatMinor(-r.delta, { decimals: false })} {sign}</span>
                  </div>
                )) : <div className="mv-empty">{t("stats.compare.moversEmptyDown")}</div>}
              </div>
            </div>
          )}

          <div className="card cmp-card">
            <div className="cmp-head">
              <div className="cmp-col-h prev">{B.label}</div>
              <div className="cmp-col-h cur">{A.label}</div>
              <div className="cmp-col-h" />
            </div>
            <div className="cmp-row cmp-total">
              <span className="cmp-name">{t("stats.compare.totalSpend")}</span>
              <span className="cmp-b">{formatMinor(data.b.spend, { decimals: false })} {sign}</span>
              <span className="cmp-a">{formatMinor(data.a.spend, { decimals: false })} {sign}</span>
              <DeltaChip a={data.a.spend} b={data.b.spend} />
            </div>
            <div className="cmp-row cmp-total">
              <span className="cmp-name">{t("stats.compare.totalIncome")}</span>
              <span className="cmp-b">{formatMinor(data.b.income, { decimals: false })} {sign}</span>
              <span className="cmp-a">{formatMinor(data.a.income, { decimals: false })} {sign}</span>
              <DeltaChip a={data.a.income} b={data.b.income} goodUp meaningful={data.income_delta_meaningful} />
            </div>
            {rows.map((r, i) => (
              <div key={i} className="cmp-row">
                <span className="cmp-name"><span className="d" style={{ background: r.color ?? "var(--muted)" }} />{r.category_name ?? noCat}</span>
                <span className="cmp-b">{formatMinor(r.b, { decimals: false })} {sign}</span>
                <span className="cmp-a">{formatMinor(r.a, { decimals: false })} {sign}</span>
                <DeltaChip a={r.a} b={r.b} meaningful={r.delta_meaningful} />
              </div>
            ))}
            {rest && (rest.a > 0 || rest.b > 0) && (
              <div className="cmp-row">
                <span className="cmp-name"><span className="d" style={{ background: "var(--muted)" }} />{t("stats.compare.otherCats")}</span>
                <span className="cmp-b">{formatMinor(rest.b, { decimals: false })} {sign}</span>
                <span className="cmp-a">{formatMinor(rest.a, { decimals: false })} {sign}</span>
                <DeltaChip a={rest.a} b={rest.b} />
              </div>
            )}
            {data.short_period && rows.some((r) => !r.delta_meaningful) && (
              <p className="muted cmp-cadence-note">{t("stats.compare.cadenceNote")}</p>
            )}
            <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
              {t("stats.compare.excludedNote")}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
