import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useGetBudgetStatusQuery, useGetCategoriesQuery } from "../../store/api.ts";
import { Money } from "../ui/Money.tsx";
import { useT } from "../../i18n/index.ts";

/**
 * Envelopes: every budgeted category is a pocket that empties as you spend (§8).
 *
 * Reads `GET /budgets/status` — the canon (`lib/finance/budgets.ts`). It used to combine
 * `/budgets` with `/analytics/by-category` and derive spent-vs-limit here, which was a THIRD
 * definition of a number the server already owns; the Telegram push once had a fourth, and quoted
 * different figures for the same envelope. The component now renders and computes nothing.
 *
 * §BUDGET-FORECAST: each envelope also shows where the month CLOSES at the current pace. That is
 * the point of the whole feature — "over budget" arriving on the 28th is a fact you can do nothing
 * about, while "heading for 130%" on the 12th is still a decision.
 */
export function EnvelopeGrid() {
  const t = useT();
  const { data: rows } = useGetBudgetStatusQuery();
  const { data: cats } = useGetCategoriesQuery();

  // Colour is the only thing still joined client-side: the canon answers about MONEY, and a
  // category's colour is not money.
  const envelopes = useMemo(() => {
    const catById = new Map((cats ?? []).map((c) => [c.id, c]));
    return [...(rows ?? [])]
      .map((r) => ({ ...r, color: catById.get(r.id)?.color ?? "#6B7A74" }))
      .sort((a, b) => b.ratio - a.ratio); // tightest envelopes first
  }, [rows, cats]);

  if (!envelopes.length) {
    return (
      <Link to="/plan" className="card empty" style={{ display: "block" }}>
        {t("eg.empty")}
      </Link>
    );
  }

  return (
    <div className="env-list">
      {envelopes.map((e) => {
        const pct = Math.round(e.ratio * 100);
        const over = e.ratio > 1;
        const state = over ? "over" : pct >= 80 ? "warn" : "ok";
        const bar = state === "over" ? "var(--neg)" : state === "warn" ? "var(--warn)" : e.color;
        const remain = e.amount - e.spent;
        // The forecast line earns its space only when it says something the bar does not: the
        // envelope is not in trouble YET, but is heading there. Once it is already over, the
        // projection is history and repeating it would be noise. `lumpy` means the projection was
        // deliberately not extrapolated (a rent payment landed, or has not landed yet) — there is
        // no pace to warn about, and claiming one would be a guess dressed as a number.
        const projPct = Math.round(e.projected_ratio * 100);
        const showForecast = !over && !e.lumpy && e.projected_ratio >= 1.05;
        return (
          <Link to="/plan" key={e.id} className={`env-item ${state}`}>
            <div className="env-top">
              <span className="env-name"><span className="d" style={{ background: e.color }} />{e.name}</span>
              <span className={`env-pct ${state}`}>{pct}%</span>
            </div>
            <div className="env-bar">
              <span style={{ transform: `scaleX(${Math.min(pct, 100) / 100})`, background: bar }} />
              {/* A hairline where the projection lands, drawn INSIDE the same track: the gap
                  between the filled bar and the mark is literally "what is still coming". */}
              {showForecast && (
                <i className="env-proj" style={{ left: `${Math.min(projPct, 100)}%` }} aria-hidden />
              )}
            </div>
            <div className="env-sub">
              <span><Money minor={e.spent} decimals={false} /> {t("common.of")} <Money minor={e.amount} decimals={false} /></span>
              <span className="env-remain">
                {remain >= 0 ? <>{t("eg.left")} <Money minor={remain} decimals={false} /></> : <>{t("eg.exceeded")}</>}
              </span>
            </div>
            {showForecast && (
              // The word "projected" is not decoration: a forecast read as a fact is a lie the app
              // tells once and then has to live with.
              <div className="env-forecast">
                {t("eg.projected", { pct: projPct })} · <Money minor={e.projected} decimals={false} />
              </div>
            )}
          </Link>
        );
      })}
    </div>
  );
}
