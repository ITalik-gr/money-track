/**
 * §BUDGET-MEMORY, read as a RECORD — «чи я взагалі тримаю план».
 *
 * `budget_months` (migration 0043) gave budgets a time dimension and then had two readers, both
 * of which threw most of it away: the auto-budget reduced a category to a pass/fail ratio, and the
 * category page drew six months of ONE envelope. So the app could say «зараз 70%» and could not
 * say the thing a person actually wants to know about a budget, which is whether it is working.
 *
 * Everything here is computed by `budgetHistory` on the server. The component renders and derives
 * nothing — the same rule that took the spent-versus-limit arithmetic out of `EnvelopeGrid`.
 */
import { useT } from "../../i18n/index.ts";
import { useGetBudgetHistoryQuery } from "../../store/api.ts";
import { Money } from "../ui/Money.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { monthShort } from "../../lib/format.ts";

function monthLabel(ym: string): string {
  const [, m] = ym.split("-");
  return monthShort(Number(m) - 1) ?? ym;
}

export function BudgetRecord() {
  const t = useT();
  const { data, error, refetch } = useGetBudgetHistoryQuery();

  return (
    <section>
      <div className="section-head">
        <h2>{t("plan.record.title")}</h2>
        <span className="label">{t("plan.record.sub")}</span>
      </div>

      <ErrorNote error={error} what={t("plan.record.error")} onRetry={refetch} />

      {data && data.months_closed === 0 && (
        // Not an error and not a failure: the record starts at the first month that closed AFTER
        // the feature existed. Saying so beats an empty card, which reads as something broken.
        <div className="card empty">{t("plan.record.empty")}</div>
      )}

      {data && data.months_closed > 0 && (
        <div className="card">
          <div className="br-head">
            <div className="br-score">
              <span className="br-pct num-hero">{data.kept_pct}%</span>
              <span className="label">{t("plan.record.keptPct", { months: data.months_closed })}</span>
            </div>
          </div>

          <ul className="bh-list">
            {data.months.map((m) => {
              // A month whose envelopes carried nothing in can have a zero limit; dividing by it
              // would print Infinity%. Same guard, same reason, as the category strip.
              const ratio = m.limit > 0 ? m.spent / m.limit : (m.spent > 0 ? 1.5 : 0);
              return (
                <li key={m.month} className={`bh-row ${m.kept ? "ok" : "over"}`}>
                  <span className="bh-month">{monthLabel(m.month)}</span>
                  <span className="bh-bar">
                    <i style={{ transform: `scaleX(${Math.min(ratio, 1)})` }} />
                    {!m.kept && <b />}
                  </span>
                  <span className="bh-num">
                    <Money minor={m.spent} decimals={false} />
                    <span className="bh-of"> / <Money minor={m.limit} decimals={false} /></span>
                  </span>
                  <span className="bh-verdict">
                    {t("plan.record.envelopesKept", { kept: m.kept_envelopes, total: m.envelopes })}
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="br-cats">
            <div className="label">{t("plan.record.byEnvelope")}</div>
            {data.categories.map((cat) => (
              <div key={cat.category_id} className="br-cat">
                <span className="br-name">
                  <span className="d" style={{ background: cat.color ?? "var(--muted)" }} />
                  {cat.name}
                </span>
                {/* One square per closed month, oldest left. A strip rather than a ratio: «3 з 6»
                    cannot tell «зривався двічі спочатку, відтоді тримає» from the reverse, and
                    those two call for opposite reactions. */}
                <span className="br-dots">
                  {cat.months.map((m) => (
                    <i key={m.month} className={m.kept ? "ok" : "over"} title={monthLabel(m.month)} />
                  ))}
                </span>
                <span className="br-streak">
                  {cat.streak > 0
                    ? t("plan.record.streak", { n: cat.streak })
                    : t("plan.record.streakNone")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
