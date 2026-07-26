import { useGetInsightQuery, useGenerateInsightMutation } from "../../store/api.ts";
import { highlightAmounts } from "../../lib/highlight.tsx";
import { RichFacts } from "./RichFacts.tsx";
import { UsageCost } from "../settings/UsageCost.tsx";
import { Icon } from "../ui/Icon.tsx";
import { useT } from "../../i18n/index.ts";

export function AiInsightCard({ days = 30 }: { days?: number }) {
  const t = useT();
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
          <div className="ai-title">{t("ai.title")}</div>
          <div className="label">{t("ai.subtitle")}</div>
        </div>
        <button className="btn" style={{ marginLeft: "auto" }} disabled={isLoading} onClick={() => gen(days)}>
          {isLoading ? t("ai.analyzing") : has ? t("ai.update") : t("ai.generate")}
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
        <p className="ai-text muted">{t("ai.emptyPrompt")}</p>
      )}
    </div>
  );
}
