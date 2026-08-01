import { useState } from "react";
import { Link } from "react-router-dom";
import { useDeleteEventMutation, useGetEventsQuery } from "../store/api.ts";
import { GroupGridSkeleton } from "../components/ui/Skeleton.tsx";
import { Money } from "../components/ui/Money.tsx";
import { Icon } from "../components/ui/Icon.tsx";
import { GroupModal, GROUP_KINDS } from "../components/planning/GroupModal.tsx";
import { EventBudgetBar } from "../components/planning/EventBudget.tsx";
import { useT, translate } from "../i18n/index.ts";
import { getLocale } from "../i18n/locale.ts";

const kindLabel = (k: string | null) => {
  const found = GROUP_KINDS.find((x) => x.value === k);
  return translate(getLocale(), found?.labelKey ?? "evt.groupFallback");
};

// Групи: об'єднати транзакції в подорож / проєкт / подію / спец-день. Головна ідея —
// дати AI контекст. Видно в статистиці й у AI-порадах.
export function Events() {
  const t = useT();
  // Скелет, а не порожній стан, поки запит летить (див. Goals — та сама пастка `= []`).
  const { data: groups = [], isLoading } = useGetEventsQuery();
  const [deleteEvent] = useDeleteEventMutation();
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="greet">{t("nav.events")}</div>
          <div className="sub">{t("events.sub")}</div>
        </div>
        <div className="page-head-actions">
          <button className="btn primary" onClick={() => setShowModal(true)}>＋ {t("events.addNew")}</button>
        </div>
      </div>

      {isLoading ? <GroupGridSkeleton /> : groups.length ? (
        <div className="group-grid">
          {groups.map((g) => (
            <Link key={g.id} to={`/events/${g.id}`} className="group-card tappable" style={{ "--group-color": g.color ?? "var(--accent)" } as React.CSSProperties}>
              <div className="group-top">
                <span className="group-ico" style={{ background: g.color ?? "var(--accent)" }}><Icon name="folder" size={18} /></span>
                <button className="group-del" aria-label={t("common.delete")}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteEvent(g.id); }}>
                  <Icon name="trash" size={15} />
                </button>
              </div>
              <div className="group-name">{g.name}</div>
              <div className="group-kind">{kindLabel(g.kind)} · {g.tx_count} {t("stats.txCountShort")}</div>
              {g.note && <div className="group-note">{g.note}</div>}
              <div className="group-foot">
                <div>
                  <div className="label">{t("events.spentLabel")}{g.budget ? <> {t("goal.ofTarget")} <Money minor={g.budget} decimals={false} /></> : null}</div>
                  <div className="group-spent"><Money minor={g.spent} decimals={false} /></div>
                </div>
                <span className="label group-link">{t("events.txLink")} →</span>
              </div>
              {g.budget ? <EventBudgetBar spent={g.spent} budget={g.budget} /> : null}
            </Link>
          ))}
        </div>
      ) : (
        <div className="card empty" style={{ padding: 28 }}>{t("events.emptyHint")}</div>
      )}

      {showModal && <GroupModal onClose={() => setShowModal(false)} />}
    </>
  );
}
