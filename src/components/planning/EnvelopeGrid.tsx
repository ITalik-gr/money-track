import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useGetBudgetStatusQuery, useGetCategoriesQuery } from "../../store/api.ts";
import { ErrorNote } from "../ui/ErrorNote.tsx";
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
 *
 * A tile links to its CATEGORY page, not to `/plan`: "why is this envelope full" is a question
 * about the category, and `/plan` only offered the same list again one level up.
 */
export function EnvelopeGrid() {
  const t = useT();
  const { data: rows, error, refetch } = useGetBudgetStatusQuery();
  const { data: cats } = useGetCategoriesQuery();

  // Colour is the only thing still joined client-side: the canon answers about MONEY, and a
  // category's colour is not money.
  const envelopes = useMemo(() => {
    const catById = new Map((cats ?? []).map((c) => [c.id, c]));
    return [...(rows ?? [])]
      .map((r) => ({ ...r, color: catById.get(r.id)?.color ?? "#6B7A74" }))
      .sort((a, b) => b.ratio - a.ratio); // tightest envelopes first
  }, [rows, cats]);

  /**
   * A failed request must not be reported as «конвертів ще немає».
   *
   * This was the strongest case in the whole error-branch sweep: the empty state is not blank, it
   * INVITES you to create envelopes — so a network hiccup told a person with a dozen budgets that
   * they had none and offered to set them up. «Порожнеча й збій виглядають по-різному» understates
   * it; here the empty state is a false statement about the account.
   */
  if (error) return <ErrorNote error={error} what={t("eg.title")} onRetry={refetch} />;

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
        // §BUDGET-ZERO: an envelope deliberately set to nothing is binary — the promise held or it
        // did not. `ratio >= 1` rather than `> 1` here, because the canon reports a broken zero
        // envelope as exactly 1: there is no "how far over" when the limit is nothing.
        const zero = e.amount === 0;
        const pct = Math.round(e.ratio * 100);
        const over = zero ? e.spent > 0 : e.ratio > 1;
        const state = over ? "over" : zero ? "ok" : pct >= 80 ? "warn" : "ok";
        const bar = state === "over" ? "var(--neg)" : state === "warn" ? "var(--warn)" : e.color;
        const remain = e.amount - e.spent;
        // The forecast line earns its space only when it says something the bar does not: the
        // envelope is not in trouble YET, but is heading there. Once it is already over, the
        // projection is history and repeating it would be noise. `lumpy` means the projection was
        // deliberately not extrapolated (a rent payment landed, or has not landed yet) — there is
        // no pace to warn about, and claiming one would be a guess dressed as a number.
        const projPct = Math.round(e.projected_ratio * 100);
        // Never on a zero envelope: "heading for 340% of nothing" is a percentage of a decision.
        const showForecast = !over && !zero && !e.lumpy && e.projected_ratio >= 1.05;
        return (
          <Link to={`/categories/${e.id}`} key={e.id} className={`env-item ${state}`}>
            <div className="env-top">
              <span className="env-name"><span className="d" style={{ background: e.color }} />{e.name}</span>
              {zero
                ? <span className={`env-zero ${state}`}>{over ? t("eg.zeroBroken") : t("eg.zeroKept")}</span>
                : <span className={`env-pct ${state}`}>{pct}%</span>}
            </div>
            {/* No track for a zero envelope: there is no proportion to fill, and a bar drawn full
                would suggest a limit was reached rather than a limit of nothing broken. */}
            {!zero && (
              <div className="env-bar">
                <span style={{ transform: `scaleX(${Math.min(pct, 100) / 100})`, background: bar }} />
                {/* A hairline where the projection lands, drawn INSIDE the same track: the gap
                    between the filled bar and the mark is literally "what is still coming". */}
                {showForecast && (
                  <i className="env-proj" style={{ left: `${Math.min(projPct, 100)}%` }} aria-hidden />
                )}
              </div>
            )}
            <div className="env-sub">
              <span>
                <Money minor={e.spent} decimals={false} /> {t("common.of")} <Money minor={e.amount} decimals={false} />
                {/* §BUDGET-MEMORY: a limit that grew by 800 ₴ on its own reads as a bug in the
                    app, so the envelope names the reason inline. The canon hands over `carried`
                    and `base_amount` precisely so this does not have to be worked out here. */}
                {e.carried !== 0 && (
                  <span className={`env-carry ${e.carried < 0 ? "neg" : ""}`}>
                    {" "}({<Money minor={e.base_amount} decimals={false} />}{e.carried > 0 ? " + " : " − "}
                    <Money minor={Math.abs(e.carried)} decimals={false} />{" "}
                    {e.carried > 0 ? t("eg.carried") : t("eg.carriedDebt")})
                  </span>
                )}
              </span>
              <span className="env-remain">
                {/* «ще 0 ₴» about an envelope that was never meant to hold anything is true and
                    empty; what matters is whether anything was spent at all. */}
                {zero ? (over ? t("eg.zeroSpentAnyway") : t("eg.zeroKept"))
                  : remain >= 0 ? <>{t("eg.left")} <Money minor={remain} decimals={false} /></>
                    : <>{t("eg.exceeded")}</>}
              </span>
            </div>
            {showForecast && (
              // The word "projected" is not decoration: a forecast read as a fact is a lie the app
              // tells once and then has to live with.
              <div className="env-forecast">
                {t("eg.projected", { pct: projPct })} · <Money minor={e.projected} decimals={false} />
              </div>
            )}
            {/* §BUDGET-REACH — the limit sits below the level the app itself computes, so «153%
                перевищено» is a verdict on arithmetic, not on the person. Named here rather than
                left to be inferred: without it the envelope reports failure every month for a
                target nothing could meet. The limit is NOT changed — the fix lives on /plan, where
                changing a limit is what the screen is for. */}
            {e.unreachable && e.level != null && (
              <div className="env-unreachable">
                {/* One sentence, with the figure INSIDE it. The first version interpolated an
                    empty `{level}` and appended the amount after — so it rendered «звичайні
                    витрати () — ціль недосяжна» with the number orphaned on the next line. */}
                <span>{t("eg.unreachable")}</span>
                <b><Money minor={e.level} decimals={false} /></b>
                <span>{t("eg.unreachableTail")}</span>
              </div>
            )}
          </Link>
        );
      })}
    </div>
  );
}
