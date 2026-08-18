import { useMemo, useState } from "react";
import { useGetAdviceQuery, useGetPatternsQuery } from "../../store/api.ts";
import { formatMinor } from "../../lib/format.ts";
import { InfoTip } from "../ui/InfoTip.tsx";
import { Range } from "../ui/Range.tsx";
import { useT } from "../../i18n/index.ts";
import { baseSign } from "../../lib/currency.ts";

// §P4: What-if симулятор — «що якщо зрізати категорію на N%». Клієнтський розрахунок від
// наявних агрегатів: cushion/burn з Порадника (`/advisor`) + місячні рівні категорій
// (`usual` з `/analytics/patterns` = канонічний `categoryMonthlyLevels`). Без бекенду.
// runway = ліквідна подушка ÷ місячний burn; зрізаємо burn на суму скорочень.
const fmt = (minor: number) => formatMinor(minor, { decimals: false });
const rw = (m: number | null) => (m == null ? "—" : m.toFixed(1));

export function WhatIf() {
  const t = useT();
  const { data: advice } = useGetAdviceQuery();
  const { data: patterns } = useGetPatternsQuery();
  const [cuts, setCuts] = useState<Record<string, number>>({});

  // Топ категорій за місячним рівнем (лише з реальним рівнем) — повзунки скорочення.
  const cats = useMemo(
    () => (patterns?.pace ?? []).filter((p) => p.usual > 0).slice().sort((a, b) => b.usual - a.usual).slice(0, 8),
    [patterns],
  );

  if (!advice || advice.monthly_burn <= 0 || advice.cushion <= 0 || cats.length === 0) return null;

  const baseBurn = advice.monthly_burn;
  const cushion = advice.cushion;
  // Значення повзунка: >0 — зрізати, <0 — навпаки додати витрат. Тож `savings` буває
  // від'ємним (перевитрата) і тоді burn росте, а runway коротшає.
  const savings = cats.reduce((s, c) => s + Math.round((c.usual * (cuts[c.category] ?? 0)) / 100), 0);
  const newBurn = Math.max(baseBurn - savings, 1);
  const baseRunway = cushion / baseBurn;
  const newRunway = cushion / newBurn;
  const deltaR = newRunway - baseRunway;
  const changed = savings !== 0;
  const tone = deltaR > 0.05 ? "pos" : deltaR < -0.05 ? "neg" : "";

  return (
    <div className="card whatif">
      <div className="section-head" style={{ marginBottom: 4 }}>
        <h2>{t("wif.title")}</h2>
        <InfoTip>{t("wif.tip")}</InfoTip>
        {changed && <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => setCuts({})}>{t("wif.resetBtn")}</button>}
      </div>

      <div className="whatif-body">
        <div className="whatif-sliders">
          {cats.map((c) => {
            const cut = cuts[c.category] ?? 0;
            return (
              <div key={c.category} className="whatif-row">
                <div className="whatif-row-head">
                  <span className="whatif-cat"><span className="d" style={{ background: c.color ?? "var(--muted)" }} />{c.category}</span>
                  <span className="whatif-usual">{fmt(c.usual)} {baseSign()}/{t("adv.monthsUnit")}</span>
                </div>
                <div className="whatif-slider-line">
                  <Range value={cut} min={-100} max={100} step={5} origin={0}
                    ariaLabel={t("wif.sliderAriaLabel", { category: c.category })}
                    onChange={(v) => setCuts((p) => ({ ...p, [c.category]: v }))} />
                  <span className={`whatif-cut ${cut > 0 ? "cut" : cut < 0 ? "raise" : ""}`}>
                    {cut > 0 ? "−" : cut < 0 ? "+" : ""}{Math.abs(cut)}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="whatif-result">
          <div className="whatif-runway-big">
            <span className="wr-label">Runway</span>
            <span className="wr-nums">
              <span className="wr-base">{rw(baseRunway)}</span>
              <span className="wr-arrow">→</span>
              <span className={`wr-new num-hero ${tone}`}>{rw(newRunway)}</span>
              <span className="wr-unit">{t("adv.monthsUnit")}</span>
            </span>
            <span className={`whatif-delta ${tone}`}>
              {changed ? <>{deltaR >= 0 ? "+" : "−"}{Math.abs(deltaR).toFixed(1)}{t("wif.deltaSuffix")}</> : t("wif.slideHint")}
            </span>
          </div>
          {/* Від'ємні заощадження — це перевитрата: називаємо річ своїм ім'ям, не «−3 068». */}
          <div className="whatif-stat">
            <span>{savings < 0 ? t("wif.extraSpending") : t("wif.savings")}</span>
            <b className={savings < 0 ? "neg" : ""}>{changed ? `${fmt(Math.abs(savings))} ${baseSign()}/${t("adv.monthsUnit")}` : "—"}</b>
          </div>
          <div className="whatif-stat"><span>{t("wif.newBurnLabel")}</span><b>{fmt(newBurn)} {baseSign()}/{t("adv.monthsUnit")}</b></div>
          {changed && (
            <div className="whatif-stat">
              <span>{t("wif.perYearLabel")}</span>
              <b className={savings < 0 ? "neg" : ""}>{fmt(Math.abs(savings) * 12)} {baseSign()}</b>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
