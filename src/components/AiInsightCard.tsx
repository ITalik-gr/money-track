import { useGetInsightQuery, useGenerateInsightMutation } from "../store/api.ts";
import { highlightAmounts } from "../lib/highlight.tsx";
import { RichFacts } from "./RichFacts.tsx";
import { UsageCost } from "./UsageCost.tsx";
import { Icon } from "./Icon.tsx";

export function AiInsightCard({ days = 30 }: { days?: number }) {
  const { data } = useGetInsightQuery();
  const [gen, { isLoading }] = useGenerateInsightMutation();
  const structured = data && !data.empty ? data.structured : undefined;
  const text = data?.text && !data.empty ? data.text : null;
  const has = !!structured || !!text;

  return (
    <div className="card ai-card">
      <div className="ai-head">
        <span className="ai-badge"><Icon name="spark" size={18} /></span>
        <div>
          <div className="ai-title">AI-огляд фінансів</div>
          <div className="label">на основі твоїх операцій</div>
        </div>
        <button className="btn" style={{ marginLeft: "auto" }} disabled={isLoading} onClick={() => gen(days)}>
          {isLoading ? "Аналізую…" : has ? "Оновити" : "Згенерувати"}
        </button>
      </div>
      {data?.usage && !data.empty && (
        <div style={{ textAlign: "right", marginTop: -6, marginBottom: 8 }}><UsageCost usage={data.usage} /></div>
      )}
      {structured ? (
        <RichFacts headline={structured.headline} facts={structured.facts} note={structured.note} />
      ) : text ? (
        <p className="ai-text">{highlightAmounts(text)}</p>
      ) : (
        <p className="ai-text muted">
          Натисни «Згенерувати» — AI подивиться твої витрати й надходження за період і коротко прокоментує, де можна зекономити.
        </p>
      )}
    </div>
  );
}
