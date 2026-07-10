import { useState } from "react";
import { Link } from "react-router-dom";
import { useDeleteEventMutation, useGetEventsQuery } from "../store/api.ts";
import { Money } from "../components/Money.tsx";
import { Icon } from "../components/Icon.tsx";
import { GroupModal, GROUP_KINDS } from "../components/GroupModal.tsx";

const kindLabel = (k: string | null) => GROUP_KINDS.find((x) => x.value === k)?.label ?? "Група";

// Групи: об'єднати транзакції в подорож / проєкт / подію / спец-день. Головна ідея —
// дати AI контекст. Видно в статистиці й у AI-порадах.
export function Events() {
  const { data: groups = [] } = useGetEventsQuery();
  const [deleteEvent] = useDeleteEventMutation();
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">Групи</div>
          <div className="sub">Об'єднуй транзакції в подорожі, проєкти й події — видно в статистиці, AI враховує опис.</div>
        </div>
        <div className="page-head-actions">
          <button className="btn primary" onClick={() => setShowModal(true)}>＋ нова група</button>
        </div>
      </div>

      {groups.length ? (
        <div className="group-grid">
          {groups.map((g) => (
            <Link key={g.id} to={`/events/${g.id}`} className="group-card tappable" style={{ "--group-color": g.color ?? "var(--accent)" } as React.CSSProperties}>
              <div className="group-top">
                <span className="group-ico" style={{ background: g.color ?? "var(--accent)" }}><Icon name="folder" size={18} /></span>
                <button className="group-del" aria-label="Видалити"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteEvent(g.id); }}>
                  <Icon name="trash" size={15} />
                </button>
              </div>
              <div className="group-name">{g.name}</div>
              <div className="group-kind">{kindLabel(g.kind)} · {g.tx_count} оп.</div>
              {g.note && <div className="group-note">{g.note}</div>}
              <div className="group-foot">
                <div>
                  <div className="label">витрачено</div>
                  <div className="group-spent"><Money minor={g.spent} decimals={false} /></div>
                </div>
                <span className="label group-link">транзакції →</span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="card empty" style={{ padding: 28 }}>
          Ще нема груп. Натисни «нова група», а тоді на «Транзакціях» → «Вибрати» додай операції гуртом.
        </div>
      )}

      {showModal && <GroupModal onClose={() => setShowModal(false)} />}
    </>
  );
}
