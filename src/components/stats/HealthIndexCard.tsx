import { Gauge } from "../ui/Gauge.tsx";
import { InfoTip } from "../ui/InfoTip.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Sparkline } from "../ui/Sparkline.tsx";
import { useGetHealthQuery } from "../../store/api.ts";
import { useT } from "../../i18n/index.ts";

// §H: Індекс фінздоров'я — детермінований (без AI), джерело worker/lib/advisor.ts financeHealth.
// 4 складові (runway / норма заощаджень / борг-дохід / стабільність) → зважений скор 0..100.
const dot = (s: number) => (s >= 70 ? "pos" : s >= 45 ? "warn" : "neg");

export function HealthIndexCard() {
  const t = useT();
  const { data } = useGetHealthQuery();
  const score = data?.score ?? null;
  const gTone = score == null ? "accent" : score >= 70 ? "pos" : score >= 45 ? "warn" : "neg";

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
      </div>

      {data ? (
        <div className="health-body">
          <div className="health-gauge">
            <Gauge ratio={(score ?? 0) / 100} center={String(score ?? "—")} sub={t("hic.of100")} tone={gTone} />
          </div>
          <div className="health-factors">
            {data.components.map((c) => (
              <div className="health-factor" key={c.key}>
                <span className="hf-lbl">
                  <span className={`hf-dot ${dot(c.score)}`} />
                  {c.label}
                  <InfoTip>{c.hint}</InfoTip>
                </span>
                <span className="hf-val">{c.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {data && (data.trend?.length ?? 0) >= 2 && (
        <div className="health-trend">
          <span className="label">{t("hic.trendLabel")}</span>
          <Sparkline values={data.trend!.map((p) => p.score)} width={120} height={26} color="var(--accent)" goodUp />
          <span className="health-trend-delta">
            {(() => {
              const tr = data.trend!; const d = tr[tr.length - 1].score - tr[0].score;
              return d === 0 ? t("hic.noChange") : t("hic.deltaOverDays", { value: `${d > 0 ? "+" : "−"}${Math.abs(d)}`, days: tr.length });
            })()}
          </span>
        </div>
      )}

      {!data && (
        <p className="muted" style={{ margin: 0 }}>{t("hic.calculating")}</p>
      )}
    </div>
  );
}
