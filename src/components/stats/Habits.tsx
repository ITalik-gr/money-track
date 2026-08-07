import { useGetHabitsQuery } from "../../store/api.ts";
import { formatMinor, monthShort } from "../../lib/format.ts";
import { HoverTip } from "../ui/HoverTip.tsx";
import { useT } from "../../i18n/index.ts";
import type { HabitChange } from "../../store/api.ts";

// §HABITS: що ТИХО зʼявилось у регулярних витратах і що ТИХО зникло.
//
// Ховаємо блок, лише коли порожні ОБИДВА списки: «нічого не змінилось» — це відповідь, але вона
// не варта картки, а «зʼявилось три нові підписки» — варта завжди.

// `since` приходить як `YYYY-MM` навмисно: місяць береться з явного ключа, а не з timestamp —
// кінець місяця в UTC підписався б наступним місяцем у Києві (CLAUDE.md, §Місяць графіка).
function monthLabel(ym: string): string {
  const [, m] = ym.split("-");
  return monthShort(Number(m) - 1);
}

function Row({ h, kind }: { h: HabitChange; kind: "started" | "stopped" }) {
  const t = useT();
  return (
    <div className="hb-row">
      <span className="hb-name" title={h.merchant}>{h.merchant}</span>
      <span className="hb-when label">
        {kind === "started"
          ? t("hb.since", { month: monthLabel(h.since) })
          : t("hb.lastSeen", { month: monthLabel(h.last) })}
      </span>
      <span className="hb-amt num-mono">{formatMinor(h.monthly, { decimals: false })} ₴</span>
    </div>
  );
}

export function Habits() {
  const t = useT();
  const { data } = useGetHabitsQuery();
  if (!data || (!data.started.length && !data.stopped.length)) return null;

  return (
    <section>
      <div className="section-head">
        <h2>{t("hb.title")}</h2>
        <HoverTip content={<>{t("hb.tip")}</>}>
          <span className="label">{t("hb.subtitle")}</span>
        </HoverTip>
      </div>
      {/* `:only-child` на сітці обов'язковий: будь-яка з половин уміє не рендеритись, і без нього
          та, що лишилась, сідає у вузьку колонку — правило, куплене тричі (CLAUDE.md). */}
      <div className="hb-grid">
        {data.started.length > 0 && (
          <div className="card hb-card">
            <div className="hb-head">
              <span className="hb-kind started">{t("hb.startedTitle")}</span>
              <span className="num-mono hb-total">
                +{formatMinor(data.started_monthly_total, { decimals: false })} ₴{t("hb.perMonth")}
              </span>
            </div>
            {data.started.map((h) => <Row key={h.merchant} h={h} kind="started" />)}
          </div>
        )}
        {data.stopped.length > 0 && (
          <div className="card hb-card">
            <div className="hb-head">
              <span className="hb-kind stopped">{t("hb.stoppedTitle")}</span>
            </div>
            {data.stopped.map((h) => <Row key={h.merchant} h={h} kind="stopped" />)}
          </div>
        )}
      </div>
    </section>
  );
}
