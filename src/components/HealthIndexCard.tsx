import { Gauge } from "./Gauge.tsx";
import { InfoTip } from "./InfoTip.tsx";
import { Icon } from "./Icon.tsx";
import { useGetHealthQuery } from "../store/api.ts";

// §H: Індекс фінздоров'я — детермінований (без AI), джерело worker/lib/advisor.ts financeHealth.
// 4 складові (runway / норма заощаджень / борг-дохід / стабільність) → зважений скор 0..100.
const dot = (s: number) => (s >= 70 ? "pos" : s >= 45 ? "warn" : "neg");

export function HealthIndexCard() {
  const { data } = useGetHealthQuery();
  const score = data?.score ?? null;
  const gTone = score == null ? "accent" : score >= 70 ? "pos" : score >= 45 ? "warn" : "neg";

  return (
    <div className="card health-card">
      <div className="ai-head">
        <span className="ai-badge soft"><Icon name="target" size={18} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="ai-title">
            Індекс здоров'я
            <InfoTip>Оцінка стану фінансів 0–100 із канонічних чисел: запас (runway), норма заощаджень, борг/дохід, стабільність доходу. Рахується детерміновано, без AI.</InfoTip>
          </div>
          <div className="label">скор 0–100 за 4 складовими</div>
        </div>
      </div>

      {data ? (
        <div className="health-body">
          <div className="health-gauge">
            <Gauge ratio={(score ?? 0) / 100} center={String(score ?? "—")} sub="зі 100" tone={gTone} />
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
      ) : (
        <p className="muted" style={{ margin: 0 }}>Рахуємо…</p>
      )}
    </div>
  );
}
