/**
 * §FX-COST — what conversion cost, which no statement ever states.
 *
 * Both halves of every foreign purchase have been stored since 2026-07 (`original_amount` in the
 * shop's currency, `amount` in the account's) and `rate_history` has held the published rate since
 * migration 0024. Nothing compared them. The gap is a real fee, folded into the price of each
 * item, and it is the only cost in the app that was invisible by construction rather than by
 * omission.
 *
 * The whole calculation is server-side (`lib/finance/fx.ts`): it needs per-day rates, and a
 * client that fetched those would be a second opinion about what a purchase was worth.
 */
import { useT } from "../../i18n/index.ts";
import { formatMinor } from "../../lib/format.ts";
import { currencyCode, currencySign } from "../../../shared/currency.ts";
import { useGetFxCostQuery } from "../../store/api.ts";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { dateFmt } from "../../i18n/locale.ts";

export function FxCostCard({ sign }: { sign: string }) {
  const t = useT();
  const { data, error, refetch } = useGetFxCostQuery();

  // Nothing was ever paid in another currency — there is genuinely nothing to show, which is the
  // one case where a block may hide itself entirely rather than render an empty state.
  if (!error && (!data || data.n === 0)) return null;

  return (
    <section>
      <div className="section-head">
        <h2>{t("stats.fx.title")}</h2>
        <InfoTip>{t("stats.fx.tip")}</InfoTip>
        <span className="label">{t("stats.fx.sub")}</span>
      </div>

      <ErrorNote error={error} what={t("stats.fx.error")} onRetry={refetch} />

      {data && data.n > 0 && (
        <div className="card fx-card">
          <div className="fx-head">
            {/* The headline is the MONEY, with the percentage under it. A markup reads as
                negligible in percent and material in hryvnia, and the second is the one a person
                can decide anything with. */}
            <span className={`fx-total num-hero ${data.cost > 0 ? "neg" : "pos"}`}>
              {data.cost > 0 ? "" : "−"}{formatMinor(Math.abs(data.cost), { decimals: false })}<span className="cur">{sign}</span>
            </span>
            <span className="label">
              {t("stats.fx.headline", { pct: Math.abs(data.cost_pct ?? 0), n: data.n })}
            </span>
          </div>

          {/*
            Everything below the headline is FOLDED (2026-08-22, the owner: «зменшити і зробити
            компактніше, можливо тільки при кліці відкривати і показувати саме конвертації»).

            The block answers one question — «скільки зʼїла конвертація» — and it was answering it
            with three stacked lists: a currency row, five worst purchases, a footnote. That is a
            screenful of detail for a figure most people read once a month, sitting in the middle
            of Огляд between things they came for. The number stays; the evidence is one click
            away, which is also the honest shape of it — the list is what you open when the number
            surprises you.
          */}
          <details className="fx-more">
            <summary className="disclose">{t("stats.fx.details")}</summary>
            <div className="fx-cur-row">
              {data.by_currency.map((c) => (
                <div key={c.code} className="fx-cur">
                  <span className="fx-cur-code">{currencySign(c.code)} {currencyCode(c.code)}</span>
                  <span className={`fx-cur-pct ${c.cost > 0 ? "neg" : "pos"}`}>
                    {c.cost_pct > 0 ? "+" : ""}{c.cost_pct}%
                  </span>
                  <span className="fx-cur-amt">{formatMinor(c.cost, { decimals: false })} {sign}</span>
                </div>
              ))}
            </div>

            <div className="fx-items">
              <div className="label">{t("stats.fx.worst")}</div>
              {data.items.map((it) => (
                <div key={it.id} className="fx-item">
                  <span className="fx-item-name">{it.merchant ?? t("common.uncategorized")}</span>
                  <span className="fx-item-orig">
                    {formatMinor(Math.abs(it.original_amount), { decimals: false })} {currencySign(it.original_currency)}
                    <span className="muted"> · {dateFmt({ day: "numeric", month: "short" }).format(new Date(it.at * 1000))}</span>
                  </span>
                  <span className={`fx-item-cost ${it.cost > 0 ? "neg" : "pos"}`}>
                    {it.cost > 0 ? "+" : ""}{formatMinor(it.cost, { decimals: false })} {sign}
                  </span>
                </div>
              ))}
            </div>

            {data.unpriced > 0 && (
              // Said out loud rather than folded in: a row priced at today's rate would turn a
              // currency move into a fee, so those rows are excluded — and an excluded row that
              // nobody mentions is a total that quietly means something else.
              <p className="muted fx-note">{t("stats.fx.unpriced", { n: data.unpriced })}</p>
            )}
          </details>
        </div>
      )}
    </section>
  );
}
