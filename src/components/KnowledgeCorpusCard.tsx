import { Icon } from "./Icon.tsx";
import { InfoTip } from "./InfoTip.tsx";
import { useGetKnowledgeQuery } from "../store/api.ts";

// Корпус знань (§A5): вбудований довідник, який AI-чат читає як стабільний контекст
// (через prompt-cache). Тут — лише список тем; сам текст живе в промті, не тягнеться в UI.
// Юзер-аплоад власних PDF/MD — наступний етап (ROADMAP).
export function KnowledgeCorpusCard() {
  const { data: docs } = useGetKnowledgeQuery();
  const list = docs ?? [];

  return (
    <div className="card corpus-card">
      <div className="ai-head">
        <span className="ai-badge soft"><Icon name="folder" size={18} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="ai-title">
            Корпус знань
            <InfoTip>Вбудований довідник (принципи фінансів, методологія застосунку, інвестиції), який AI-чат читає як стабільний контекст — тож поради спираються на ці правила. Завантаження власних документів — згодом.</InfoTip>
          </div>
          <div className="label">що чат знає крім твоїх даних</div>
        </div>
      </div>

      <div className="corpus-list">
        {list.map((d) => (
          <div className="corpus-doc" key={d.id}>
            <Icon name="report" size={15} />
            <div style={{ minWidth: 0 }}>
              <div className="corpus-doc-title">{d.title}</div>
              <div className="corpus-doc-sum">{d.summary}</div>
            </div>
          </div>
        ))}
      </div>

      <p className="corpus-hint">Активно в чаті-пораднику. Скоро: завантаження власних PDF/MD, цитування за сторінкою.</p>
    </div>
  );
}
