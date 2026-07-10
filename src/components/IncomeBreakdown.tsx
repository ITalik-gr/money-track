import { useGetIncomeAnalyticsQuery } from "../store/api.ts";
import { formatMinor } from "../lib/format.ts";
import { HoverTip } from "./HoverTip.tsx";

// §1 Аналітика доходу: джерела (по категоріях), стабільність (варіативність 6 міс) і
// дельта проти минулого періоду. Зведено в ₴. Дзеркалить канон Статистики.
const FALLBACK = ["#12805c", "#2e6be6", "#7a3e9d", "#c9871a", "#127c86", "#6b7a74"];
const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const stabTone: Record<string, string> = { стабільний: "pos", помірний: "warn", нестабільний: "neg" };

export function IncomeBreakdown({ preset, currency, sign }: { preset: string; currency: number | null; sign: string }) {
  const { data } = useGetIncomeAnalyticsQuery({ preset, currency });
  if (!data || data.total === 0) return null;

  const srcMax = Math.max(...data.sources.map((s) => s.amount), 1);
  const monMax = Math.max(...data.monthly.map((m) => m.income), 1);
  const delta = data.delta_pct;
  const tone = stabTone[data.stability.label] ?? "";

  return (
    <section>
      <div className="section-head">
        <h2>Надходження</h2>
        <span className="label">джерела · стабільність</span>
      </div>
      <div className="stats-2col">
        <div className="card deep-card">
          <div className="inc-head">
            <div>
              <span className="label">Дохід за період</span>
              <div className="num-hero" style={{ fontSize: 30 }}>{formatMinor(data.total, { decimals: false })}<span className="cur" style={{ fontSize: "0.5em", color: "var(--muted)", marginLeft: 4 }}>{sign}</span></div>
            </div>
            {delta != null && delta !== 0 && (
              <span className={`cmp-delta ${delta > 0 ? "down" : "up"}`} title="проти минулого періоду">{delta > 0 ? "+" : ""}{delta}%</span>
            )}
          </div>
          <div className="inc-sources">
            {data.sources.slice(0, 6).map((s, i) => (
              <div key={s.category_id ?? i} className="inc-src">
                <span className="is-name"><span className="d" style={{ background: s.color ?? FALLBACK[i % FALLBACK.length] }} />{s.name}</span>
                <span className="is-track"><span style={{ width: `${(s.amount / srcMax) * 100}%`, background: s.color ?? FALLBACK[i % FALLBACK.length] }} /></span>
                <span className="is-val">{formatMinor(s.amount, { decimals: false })} {sign} <span className="muted">· {s.pct}%</span></span>
              </div>
            ))}
          </div>
        </div>

        <div className="card deep-card">
          <div className="deep-title">
            Стабільність доходу{" "}
            <HoverTip content={<>Наскільки рівний дохід по місяцях. Коеф. варіації (розкид/середнє) за повні місяці: ≤15% — стабільний, ≤40% — помірний, вище — нестабільний.</>}>
              <span className="label" style={{ fontWeight: 400 }}>· що це?</span>
            </HoverTip>
          </div>
          <div className="inc-stab">
            <span className={`stab-badge ${tone}`}>{data.stability.label}</span>
            {data.stability.cv_pct != null && <span className="muted" style={{ fontSize: 12.5 }}>розкид ±{data.stability.cv_pct}%</span>}
          </div>
          <div className="inc-months">
            {data.monthly.map((m, i) => (
              <HoverTip key={i} content={<><div className="tip-lbl">{MONTHS[Number(m.month.split("-")[1]) - 1]}</div><div className="r">{formatMinor(m.income, { decimals: false })} {sign}</div></>}>
                <div className="im-col">
                  <div className="im-bar-wrap"><div className="im-bar" style={{ height: `${(m.income / monMax) * 100}%` }} /></div>
                  <span className="im-lbl">{MONTHS[Number(m.month.split("-")[1]) - 1]}</span>
                </div>
              </HoverTip>
            ))}
          </div>
          <p className="deep-desc">
            {data.stability.label === "стабільний" ? "Дохід рівний з місяця в місяць — легше планувати бюджет." :
             data.stability.label === "нестабільний" ? "Дохід стрибає — тримай запас на слабші місяці." :
             "Дохід помірно коливається — орієнтуйся на середнє, не на пік."}
          </p>
        </div>
      </div>
    </section>
  );
}
