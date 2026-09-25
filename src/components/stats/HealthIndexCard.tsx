import { Gauge } from "../ui/Gauge.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { Icon } from "../ui/Icon.tsx";
import { HealthTrend, shortDay } from "./HealthTrend.tsx";
import { useGetHealthQuery } from "../../store/api.ts";
import { useT } from "../../i18n/index.ts";

// §H: Індекс фінздоров'я — детермінований (без AI), джерело worker/lib/finance/health.ts.
// 4 складові (runway / норма заощаджень / борг-дохід / стабільність) → зважений скор 0..100.
const dot = (s: number) => (s >= 70 ? "pos" : s >= 45 ? "warn" : "neg");

/**
 * The band, resolved through a MAP rather than by concatenating the band into a key.
 *
 * §I18N-DYNKEY: a key assembled at runtime is invisible to the parity lint, so a band whose
 * string is missing from one dictionary prints the raw key on screen and nothing catches it.
 * A map is checked by `tsc` and each key is an ordinary literal the lint can see.
 */
const BAND_KEY = { good: "hic.band.good", ok: "hic.band.ok", risk: "hic.band.risk" } as const;

/** Whole days between two `YYYY-MM-DD` keys, i.e. what the window actually SPANS. */
function daysBetween(a: string, b: string): number {
  return Math.max(1, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000));
}

const signed = (d: number) => `${d > 0 ? "+" : "−"}${Math.abs(d)}`;
const deltaTone = (d: number) => (d > 0 ? "pos" : d < 0 ? "neg" : "flat");

export function HealthIndexCard() {
  const t = useT();
  const { data, error, refetch } = useGetHealthQuery();
  // §HEALTH: a provisional index gets no number and no band — the parts below say what IS known.
  const score = data && !data.insufficient ? data.score : null;
  const gTone = score == null ? "accent" : score >= 70 ? "pos" : score >= 45 ? "warn" : "neg";
  const trend = data?.trend ?? [];

  return (
    <div className="card health-card">
      <div className="ai-head">
        <span className="ai-badge soft"><Icon name="target" size={18} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="ai-title">
            {t("hic.title")}
            <InfoTip>{t("hic.tip")}</InfoTip>
          </div>
          <div className="label">{t("hic.subtitle")}</div>
        </div>
        {/* The band in words. The gauge is already coloured by it, but a colour is not a reading:
            «21 зі 100» invites «out of what» and the answer is a three-step scale, not a target. */}
        {data && score != null && <span className={`hic-band ${gTone}`}>{t(BAND_KEY[data.band])}</span>}
      </div>

      {/* The card already renders a dash for «score unknown», which is right — and made a FAILURE
          indistinguishable from «not enough data yet». That is the exact confusion the rule names:
          порожнеча й збій виглядають по-різному. */}
      <ErrorNote error={error} what={t("hic.title")} onRetry={refetch} />

      {data ? (
        <div className="health-body">
          <div className="health-gauge">
            <Gauge ratio={(score ?? 0) / 100} center={String(score ?? "—")} sub={t("hic.of100")} tone={gTone} />
          </div>
          <div className="health-factors">
            {data.components.map((c) => {
              /**
               * How many of the 100 points this component actually contributes, and how many it
               * could. Four values with four dots read as four equal problems; they are not —
               * stability is worth 15 points and the cushion 35, so «59% стабільності» looks like
               * the bigger failure while costing a third as much. The weight comes from the
               * worker (`HealthComponent.weight`), the same constant the score is summed from.
               */
              // ⚠️ Both numbers come from the worker (2026-09-25). The card used to round each part
              // on its own, and in about a third of real cases the four «got» added up to one more
              // or one less than the gauge above them. `points` are allocated so they sum exactly.
              const max = Math.round(c.weight * 100);
              const tone = c.measured ? dot(c.score) : "idle";
              return (
                <div className="health-factor" key={c.key}>
                  <span className="hf-lbl">
                    <span className={`hf-dot ${tone}`} />
                    {c.label}
                    <InfoTip>{c.hint}</InfoTip>
                  </span>
                  <span className="hf-val">{c.value}</span>
                  <span className={`hf-bar ${tone}`} aria-hidden>
                    <i style={{ width: `${c.measured ? Math.max(2, c.score) : 0}%` }} />
                  </span>
                  <span className="hf-pts">{c.measured ? t("hic.points", { got: c.points, max }) : "—"}</span>
                </div>
              );
            })}
          </div>
          {/* A score resting on less than half its formula is a first impression, not a verdict —
              a new account would otherwise meet a confident «risk» on its first day. */}
          {data.insufficient && <p className="hic-provisional">{t("hic.insufficient")}</p>}
        </div>
      ) : null}

      {/**
        * The trend, given room.
        *
        * ⚠️ Two deltas, not one, and they answer different questions. «Since the previous
        * calculation» is what MOVED — the score is re-recorded on every visit, so this is the
        * effect of everything that happened between two openings of the page. «Over the window»
        * is where the index has been drifting, which a single day's move cannot show and which is
        * the number that should actually change behaviour.
        * ⚠️ The window is measured from the DAY KEYS, not from the number of points. Scores are
        * written only on days the app is opened, so `trend.length` was being printed as «за 32 дн»
        * for a stretch of 45 calendar days — a caption that quietly re-scaled itself according to
        * how often the owner had visited.
        */}
      {trend.length >= 2 && (() => {
        const last = trend[trend.length - 1];
        const prev = trend[trend.length - 2];
        const first = trend[0];
        const overall = last.score - first.score;
        const step = last.score - prev.score;
        const days = daysBetween(first.day, last.day);
        const scores = trend.map((p) => p.score);
        return (
          <div className="health-trend">
            <div className="ht-head">
              <span className="label">{t("hic.trendLabel")}</span>
              <span className="ht-deltas">
                <span className={`ht-delta ${deltaTone(step)}`}>
                  {step === 0 ? t("hic.sameAsPrev") : t("hic.deltaSincePrev", { value: signed(step), day: shortDay(prev.day) })}
                </span>
                <span className={`ht-delta ${deltaTone(overall)}`}>
                  {overall === 0 ? t("hic.noChange") : t("hic.deltaOverDays", { value: signed(overall), days })}
                </span>
              </span>
            </div>
            <HealthTrend trend={trend} components={data?.components ?? []} />
            <div className="ht-axis">
              <span>{shortDay(first.day)}</span>
              <span className="ht-range">
                {t("hic.minMax", { min: Math.min(...scores), max: Math.max(...scores), n: trend.length })}
              </span>
              <span>{shortDay(last.day)}</span>
            </div>
          </div>
        );
      })()}

      {!data && (
        <p className="muted" style={{ margin: 0 }}>{t("hic.calculating")}</p>
      )}
    </div>
  );
}
