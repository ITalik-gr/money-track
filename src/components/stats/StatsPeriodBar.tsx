import { useT } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";
import { Select } from "../ui/Select.tsx";
import { currencySign } from "../../lib/format.ts";
import { RANGES, type Cur, type RangeKey } from "./shared.tsx";

/** `YYYY-MM` of the current month, and the same string shifted — the page's own month arithmetic. */
export function curYm(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftYm(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y!, m! - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * The period controls of `/stats` — the one part of that page's shell that is not about data.
 *
 * Split out of `Stats.tsx` on 2026-09-18 (`NIGHT.md` §5, «оболонка виділена, лишився розмір»). The
 * shell still owns the STATE and the one shared request every tab reads; what moved is the cluster
 * that decides which period is on screen, which is a self-contained control with a small interface
 * and no knowledge of what is being measured.
 *
 * ⚠️ The props are an INTERFACE, not a bag of setters: `onRange` / `onToggleMode` / `onYm` /
 * `onCurrency`. Passing `setSearchParams` down would have let this component write any key it
 * liked into the page's URL, and the next edit would have done exactly that.
 *
 * ⚠️ §MONTH-VIEW: in month mode the period controls are REPLACED, not merely ignored — a range
 * picker still on screen while a named month decides the window is a control that does nothing.
 */
export function StatsPeriodBar({
  range, mode, ym, ymLabel, currency, currencies,
  onRange, onToggleMode, onYm, onCurrency,
}: {
  range: RangeKey;
  mode: "calendar" | "rolling";
  ym: string | null;
  ymLabel: string | null;
  currency: Cur;
  currencies: number[] | undefined;
  onRange: (k: RangeKey) => void;
  onToggleMode: () => void;
  /** `null` leaves month mode and goes back to the range presets. */
  onYm: (ym: string | null) => void;
  onCurrency: (c: Cur) => void;
}) {
  const t = useT();
  return (
      <div className="page-head-actions">
        {/* §MONTH-VIEW: in month mode the period controls are REPLACED, not merely ignored. A
            range picker still on screen while a named month decides the window is a control
            that does nothing — the same defect as `budgets.rollover` before §BUDGET-MEMORY. */}
        {ym ? (
          <div className="month-nav">
            {/* Chevrons, not the literal «‹ ›» glyphs. Those are text: they inherit the body
                font, sit off the optical centre of a square button and change weight with the
                typeface — which is why the stepper read as unfinished next to every other
                control on the page, all of which are icon-drawn. */}
            <button className="seg-btn month-nav-arrow" aria-label={t("stats.month.prev")} title={t("stats.month.prev")}
              onClick={() => onYm(shiftYm(ym, -1))}>
              <Icon name="chevron" size={16} />
            </button>
            <span className="month-nav-lbl">{ymLabel}</span>
            <button className="seg-btn month-nav-arrow next" aria-label={t("stats.month.next")} title={t("stats.month.next")}
              disabled={shiftYm(ym, 1) >= curYm()}
              onClick={() => onYm(shiftYm(ym, 1))}>
              <Icon name="chevron" size={16} />
            </button>
            <button className="pill-toggle" onClick={() => onYm(null)}>
              <Icon name="calendar" size={14} />{t("stats.month.back")}
            </button>
          </div>
        ) : (
          <>
            <div className="seg">
              {(Object.keys(RANGES) as RangeKey[]).map((k) => (
                <button key={k} className={`seg-btn ${range === k ? "active" : ""}`} onClick={() => onRange(k)}>
                  {t(RANGES[k].labelKey)}
                </button>
              ))}
            </div>
            <button className="pill-toggle" title={t("stats.modeTip")}
              onClick={onToggleMode}>
              <Icon name={mode === "calendar" ? "calendar" : "repeat"} size={14} />
              {mode === "calendar" ? t("stats.mode.calendar") : t("stats.mode.rolling")}
            </button>
            {/* §MONTH-VIEW: the WAY IN. The mode shipped reachable only by typing `?ym=` into the
                address bar or by finding a bar to click on another tab — i.e. a feature that
                exists and cannot be found is a feature that does not exist. Opens the last
                COMPLETE month; the ‹ › stepper takes over from there. */}
            {/* ⚠️ NOT another calendar pill. It sat next to the period-mode toggle wearing the
                same shape AND the same calendar icon, and the owner could not tell them apart —
                fairly, since they do unrelated things: one flips a SETTING, this one leaves for
                another VIEW. It now carries the same chevron as the stepper it becomes, and the
                accent outline says "this navigates" the way the toggle's plain one does not. */}
            <button className="pill-toggle month-open" title={t("stats.month.browseTip")}
              onClick={() => onYm(shiftYm(curYm(), -1))}>
              <Icon name="chevron" size={14} />{t("stats.month.browse")}
            </button>
          </>
        )}
        {currencies && currencies.length > 1 && (
          <Select
            className="ph-cur-sel"
            value={currency ?? "all"}
            options={[{ value: "all", label: t("stats.curUah") }, ...currencies.map((c) => ({ value: c, label: currencySign(c) }))]}
            onChange={(v) => onCurrency(v === "all" ? null : Number(v))}
          />
        )}
      </div>
  );
}
