/**
 * §INCOME-SPLIT — of what came IN, what each importance band took.
 *
 * `ImportanceBreakdown` already draws these three bands as shares of SPENDING, which describes the
 * spending and cannot say whether it was affordable: essentials at 40% of spending look identical
 * whether income was double the outgoings or half of them. Measured against INCOME the same three
 * numbers become the answer to «чи я живу по засобах», and the leftover is the savings rate with
 * its parts shown rather than asserted.
 *
 * ⚠️ The bar can OVERFLOW past 100%, and it is drawn that way when it does: a month that ran on
 * savings is exactly the month this block exists for, and a bar clamped at full would report the
 * worst case as a completed one.
 */
import { useT } from "../../i18n/index.ts";
import { formatMinor } from "../../lib/format.ts";
import { useGetIncomeSplitQuery } from "../../store/api.ts";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { HoverTip } from "../ui/HoverTip.tsx";
import { IMPORTANCE_META, IMPORTANCE_LEVELS } from "../../lib/importance.ts";

/**
 * The bands, their colours and their labels come from `IMPORTANCE_META` — the same map the
 * importance picker, the monthly-history strip and the transaction detail read. A local palette
 * here would give one concept two colours on one page, and §I18N-DYNKEY asks for a map rather than
 * a key built by concatenation (`t(\`imp.${x}\`)` printed a raw key on screen once already).
 */
const BANDS = IMPORTANCE_LEVELS;

export function IncomeSplit({ from, to, sign }: { from: number; to: number; sign: string }) {
  const t = useT();
  const { data, error, refetch } = useGetIncomeSplitQuery({ from, to });

  if (error) return <ErrorNote error={error} what={t("stats.split.title")} onRetry={refetch} />;
  // No income is not "0% went to essentials" — it is a period the question cannot be asked about,
  // and the server says so by returning `shares: null` (the same refusal as `savingsRatePct`).
  if (!data || !data.shares) return null;

  const money = (m: number) => `${formatMinor(m, { decimals: false })} ${sign}`;
  const pct = (v: number) => Math.round(v * 100);
  const over = data.left < 0;

  return (
    <section>
      <div className="section-head">
        <h2>{t("stats.split.title")}</h2>
        <HoverTip content={<>{t("stats.split.tip")}</>}>
          <span className="label">{t("common.whatIsThis")}</span>
        </HoverTip>
      </div>
      <div className="card is-card">
        <div className="is-head">
          <span>{t("stats.split.income")} <b>{money(data.income)}</b></span>
          <span className={`is-left ${over ? "neg" : "pos"}`}>
            {over ? t("stats.split.over") : t("stats.split.left")} <b>{money(Math.abs(data.left))}</b>
          </span>
        </div>

        {/* One track, filled by the three bands in order of how little choice there was. The
            remainder is deliberately EMPTY track rather than a fourth colour: what is left is the
            absence of spending, and giving it a fill would make it look like another destination. */}
        <div className={`is-bar ${over ? "over" : ""}`}>
          {BANDS.map((b) => {
            const share = data.shares![b];
            return share > 0 ? (
              <span key={b} className="is-seg" style={{ width: `${Math.min(100, pct(share))}%`, background: IMPORTANCE_META[b].color }} />
            ) : null;
          })}
        </div>

        <div className="is-legend">
          {BANDS.map((b) => (
            <span key={b} className="is-leg">
              <span className="d" style={{ background: IMPORTANCE_META[b].color }} />
              {t(IMPORTANCE_META[b].labelKey)}
              <b>{pct(data.shares![b])}%</b>
              <span className="muted">{money(data[b])}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
