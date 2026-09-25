/**
 * §FLOOR + §COMMITTED — one card: what a month costs with no decisions in it, and how much of the
 * income that takes.
 *
 * ⚠️ **Two cards became one (2026-09-25, UI_PASS S8).** The owner, about «Скільки коштує просто
 * жити» and «Скільки доходу вже зайнято»: «інтуїтивно не зрозумілі, інфи особливо не дають». They
 * were one idea told twice — the same floor, once as a ledger against the burn and once as a share
 * of income — and each needed the other to make sense: the ledger had no scale («is 28 707 a lot?»)
 * and the percentage had no content («62% of what, made of what?»). Now the floor is stated once,
 * drawn ON the income it is measured against, and the rest of the card answers the two follow-ups:
 * what it is made of, and how long the cushion covers it.
 *
 * Rules kept from both:
 * ⚠️ «Uneven» is about RHYTHM, never «money you could skip» — a quarterly tax is lumpy and owed.
 * ⚠️ The full-burn runway stays the headline; the floor-only one is its condition-labelled second.
 * ⚠️ Fixed costs as a share of income are never green: neutral below 70%, `--warn` from 70%, red
 * past 100% (DESIGN §6: a neutral state is not green).
 * ⚠️ No levels yet → no card: «0 ₴ a month» is a confident answer about an account not yet seen.
 */
import { useT } from "../../i18n/index.ts";
import { dateFmt } from "../../i18n/locale.ts";
import { Money } from "../ui/Money.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { HoverTip } from "../ui/HoverTip.tsx";
import { useGetSpendFloorQuery, useGetCommittedQuery } from "../../store/api.ts";

const fmtMonth = dateFmt({ month: "short" });
const fmtMonthLong = dateFmt({ month: "long", year: "numeric" });
const monthOf = (ym: string) => new Date(`${ym}-15T12:00:00Z`);
const toneOf = (share: number) => (share > 1 ? "neg" : share >= 0.7 ? "warn" : "idle");
const pctOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export function SpendFloorCard() {
  const t = useT();
  const { data } = useGetSpendFloorQuery();
  const { data: cm } = useGetCommittedQuery();
  if (!data || data.burn <= 0) return null;

  const income = cm?.income != null && cm.income > 0 ? cm.income : null;
  // The bar's length is the larger of income and the month's cost, so an overshoot is DRAWN (the
  // cost runs past the income mark) instead of being clipped to a full bar.
  const scale = Math.max(income ?? 0, data.burn);
  const free = income != null ? income - data.burn : null;
  const tone = income != null ? toneOf(data.floor / income) : "idle";

  const seg = (label: string, amount: number, cls: string) => (
    <HoverTip content={
      <>
        <div className="tip-lbl">{label}</div>
        <div className="tip-big"><Money minor={amount} decimals={false} /></div>
        {income != null && <div className="tip-muted">{t("base.ofIncome", { pct: pctOf(amount, income) })}</div>}
      </>
    }>
      <span className={`mb-seg ${cls}`} style={{ width: `${(amount / scale) * 100}%` }} />
    </HoverTip>
  );

  const first = cm?.trend[0];
  const nowPct = income != null ? pctOf(data.floor, income) : null;
  const moved = first && cm && cm.trend.length >= 2 && nowPct != null ? nowPct - Math.round((first.share ?? 0) * 100) : null;
  const maxShare = cm ? Math.max(1, ...cm.trend.map((p) => p.share ?? 0)) : 1;

  return (
    <div className="card floor-card">
      <div className="ai-head">
        <div style={{ minWidth: 0 }}>
          <div className="ai-title">{t("base.title")}<InfoTip>{t("base.tip")}</InfoTip></div>
          <div className="label">{t("base.sub")}</div>
        </div>
      </div>

      {/* The answer first, as a sentence with its numbers in it. */}
      <div className="mb-hero">
        <span className="mb-amt"><Money minor={data.burn} decimals={false} /><small>{t("base.perMonth")}</small></span>
        {nowPct != null && <span className={`mb-pct ${tone}`}>{t("base.fixedIsPct", { pct: nowPct })}</span>}
      </div>

      <div className="mb-bar-wrap">
        <div className="mb-bar" role="img" aria-label={t("base.barLabel")}>
          {seg(t("base.fixed"), data.floor, "fixed")}
          {data.lumpy > 0 && seg(t("base.lumpy"), data.lumpy, "lumpy")}
          {free != null && free > 0 && seg(t("base.free"), free, "free")}
          {income != null && data.burn > income && (
            <span className="mb-income-mark" style={{ left: `${(income / scale) * 100}%` }} />
          )}
        </div>
        <div className="mb-legend">
          <span><i className="fixed" />{t("base.fixed")} <b><Money minor={data.floor} decimals={false} /></b></span>
          {data.lumpy > 0 && (
            <span><i className="lumpy" />{t("base.lumpy")} <b><Money minor={data.lumpy} decimals={false} /></b><InfoTip>{t("base.lumpyTip")}</InfoTip></span>
          )}
          {free != null && (free >= 0
            ? <span><i className="free" />{t("base.free")} <b><Money minor={free} decimals={false} /></b></span>
            : <span className="neg">{t("base.short")} <b><Money minor={-free} decimals={false} /></b></span>)}
          {income != null && <span className="mb-income">{t("base.income", { n: cm?.months ?? 0 })} <b><Money minor={income} decimals={false} /></b></span>}
        </div>
      </div>

      {data.runway_months != null && (
        <p className="mb-runway">
          {t("base.runway", { months: data.runway_months })}{" "}<span className="muted">(<Money minor={data.cushion} decimals={false} />)</span>
          {data.floor_months != null && data.floor_months !== data.runway_months && <> {t("base.runwayFloor", { months: data.floor_months })}</>}
        </p>
      )}

      {data.parts.length > 0 && (
        <div className="mb-block">
          <div className="label">{t("base.made")}</div>
          <div className="floor-chips">
            {data.parts.map((p) => (
              <HoverTip key={p.category_id} content={<><div className="tip-lbl">{p.name}</div><div className="tip-muted">{t("base.partShare", { pct: pctOf(p.level, data.floor) })}</div></>}>
                <span className="floor-chip">
                  <span className="d" style={{ background: p.color ?? "var(--muted)" }} />
                  {p.name}
                  <b><Money minor={p.level} decimals={false} /></b>
                </span>
              </HoverTip>
            ))}
          </div>
        </div>
      )}

      {cm && cm.trend.length >= 2 && (
        <div className="mb-block">
          <div className="cm-trend-head">
            <span className="label">{t("base.trend")}</span>
            {moved != null && moved !== 0 && first && (
              <span className={`cm-moved ${moved > 0 ? "neg" : "pos"}`}>
                {t("base.moved", { value: `${moved > 0 ? "+" : "−"}${Math.abs(moved)}`, month: fmtMonth.format(monthOf(first.ym)) })}
              </span>
            )}
          </div>
          <div className="cm-cols">
            {cm.trend.map((p) => {
              const s = p.share ?? 0;
              return (
                <HoverTip key={p.ym} content={
                  <>
                    <div className="tip-lbl">{fmtMonthLong.format(monthOf(p.ym))}</div>
                    <div className="tip-big">{Math.round(s * 100)}%</div>
                    <div className="tip-kv"><span>{t("base.fixed")}</span><span><Money minor={p.floor} decimals={false} /></span></div>
                    {p.income != null && <div className="tip-kv"><span>{t("base.incomeShort")}</span><span><Money minor={p.income} decimals={false} /></span></div>}
                  </>
                }>
                  <div className="cm-col">
                    <span className="cm-col-v">{Math.round(s * 100)}%</span>
                    <span className="cm-col-track"><i className={toneOf(s)} style={{ height: `${Math.max(4, (s / maxShare) * 100)}%` }} /></span>
                    <span className="cm-col-m">{fmtMonth.format(monthOf(p.ym))}</span>
                  </div>
                </HoverTip>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
