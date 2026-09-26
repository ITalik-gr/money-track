/**
 * §SHAPE — three answers about the SHAPE of a period, not its size.
 *
 * Every other block on Statistics answers "how much, and where". Two months with the same total
 * and the same categories can still be very different months, and the difference is the part a
 * person can act on:
 *   • a few large payments or a hundred small ones — opposite remedies, identical totals;
 *   • how much of the money never passes through any envelope — the blind spot of `/plan`, where
 *     every envelope can be green while most of the spending happens outside all of them;
 *   • how much the app cannot attribute at all — the honest caveat on every other number here.
 *
 * Server-computed (`lib/finance/spending-shape.ts`) against the same canonical spend population as
 * the totals above it, so the bars add up to the figure the page already shows.
 */
import { catColor } from "../../lib/theme.ts";
import { useT } from "../../i18n/index.ts";
import { formatMinor } from "../../lib/format.ts";
import { useGetSpendingShapeQuery } from "../../store/api.ts";
import { FactLabel } from "./shared.tsx";
import { HoverTip, TipBody } from "../ui/HoverTip.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import type { Cur } from "./shared.tsx";

/** One colour per bucket, small → large. Deliberately a single hue's ramp: these are one quantity
 *  at four sizes, not four unrelated things, and a categorical palette would say otherwise. */
const BUCKET_TONES = ["var(--accent-soft)", "color-mix(in srgb, var(--accent) 45%, var(--surface))", "color-mix(in srgb, var(--accent) 75%, var(--surface))", "var(--accent)"];

export function SpendingShape({ from, to, currency, sign }: {
  from: number; to: number; currency: Cur; sign: string;
}) {
  const t = useT();
  const { data, error, refetch } = useGetSpendingShapeQuery({ from, to, currency });
  // A block that just disappears says "nothing here" for both an empty period and a failed
  // request; only the empty half is an answer (§Обробка помилок).
  if (error) return <ErrorNote error={error} what={t("stats.shape.title")} onRetry={refetch} />;
  if (!data || data.spend <= 0) return null;

  const money = (m: number) => `${formatMinor(m, { decimals: false })} ${sign}`;
  // The label is built from the bounds the SERVER converted, so the boundaries a reader sees are
  // the ones the buckets were actually cut at (§BASE-CUR) — not round numbers in another currency.
  const bound = (m: number) => formatMinor(m, { decimals: false });
  const label = (b: typeof data.buckets[number]) =>
    b.up_to == null ? t("stats.shape.bucketFrom", { from: bound(b.from) })
      : b.from === 0 ? t("stats.shape.bucketUnder", { to: bound(b.up_to) })
        : t("stats.shape.bucketRange", { from: bound(b.from), to: bound(b.up_to) });

  // ST4: the block leads with the ONE sentence the bar exists for — which cheque size carries the
  // most money, and how many operations that is. It used to be a 14px bar, a four-row legend and
  // two full tiles: the largest block of the tab for a fact that fits in a line.
  const lead = data.buckets.reduce((m, b) => (b.share_pct > m.share_pct ? b : m), data.buckets[0]);

  return (
    <section>
      <div className="section-head">
        <h2>{t("stats.shape.title")}</h2>
        <span className="label">{t("stats.shape.sub")}</span>
      </div>

      <div className="card shape-card">
        <p className="shape-lead">
          {t("stats.shape.lead", { pct: lead.share_pct, n: lead.n, size: label(lead) })}
        </p>
        <div className="shape-bar">
          {data.buckets.map((b, i) => (
            b.spent > 0 && (
              <HoverTip key={i} content={<TipBody label={label(b)} color={BUCKET_TONES[i]} value={money(b.spent)}
                sub={<>{b.share_pct}% · {t("stats.shape.nOps", { n: b.n })}</>} />}>
                <span className="shape-seg" style={{ width: `${b.share_pct}%`, background: catColor(BUCKET_TONES[i]) }} />
              </HoverTip>
            )
          ))}
        </div>
        <div className="shape-legend">
          {data.buckets.map((b, i) => (
            <span key={i} className="shape-leg">
              <span className="d" style={{ background: catColor(BUCKET_TONES[i]) }} />
              {label(b)}
              {/* The COUNT next to the share is the whole point: «38% витрат — це 214 покупок» is a
                  different month from «38% — це три платежі», and the share alone hides which. */}
              <span className="shape-leg-v">{b.share_pct}% · {t("stats.shape.nOps", { n: b.n })}</span>
            </span>
          ))}
        </div>
        <div className="shape-foot">
          <div>
            <FactLabel info={<>{t("stats.shape.unbudgetedInfo")}</>}>{t("stats.shape.unbudgeted")}</FactLabel>
            <div className="shape-foot-v">
              <b>{data.unbudgeted.share_pct == null ? "—" : `${data.unbudgeted.share_pct}%`}</b>
              <span>{money(data.unbudgeted.spent)}</span>
            </div>
          </div>
          <div>
            <FactLabel info={<>{t("stats.shape.uncategorisedInfo")}</>}>{t("stats.shape.uncategorised")}</FactLabel>
            {/* Zero here is a RESULT, not an absence — «нічого не загублено» is worth printing. */}
            <div className="shape-foot-v">
              <b className={data.uncategorised.spent > 0 ? "neg" : ""}>{data.uncategorised.share_pct == null ? "—" : `${data.uncategorised.share_pct}%`}</b>
              <span>
                {data.uncategorised.n > 0
                  ? `${money(data.uncategorised.spent)} · ${t("stats.shape.nOps", { n: data.uncategorised.n })}`
                  : t("stats.shape.allAttributed")}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
