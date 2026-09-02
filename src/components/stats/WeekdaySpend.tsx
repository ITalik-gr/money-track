import { useGetWeekdayQuery } from "../../store/api.ts";
import { formatMinor, weekdayShort } from "../../lib/format.ts";
import { HoverTip } from "../ui/HoverTip.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { useT } from "../../i18n/index.ts";
import type { Preset } from "../../store/api.ts";

// §WEEKDAY: коли саме витрачаються гроші. Решта Статистики відповідає на «скільки» і «на що»;
// це — на «коли», і саме воно піддається зміні поведінки без відмови від чогось конкретного.
//
// Показуємо ТИПОВИЙ день (`typical` = сума ÷ кількість таких днів у вікні), а не суму: у місяці
// пʼятниць 5, а субот 4, тож стовпчики сум порівнювати не можна. Ділення робить сервер — інакше
// екран і AI-контекст рахували б одну цифру двічі й розійшлись.
export function WeekdaySpend({ preset, from, to, currency }: {
  preset: Preset; from?: number; to?: number; currency: number | null;
}) {
  const t = useT();
  // §MONTH-VIEW: explicit bounds win, so browsing a past month re-cuts this chart too.
  const { data, error, refetch } = useGetWeekdayQuery(from != null && to != null ? { from, to, currency } : { preset, currency });
  // A block that just disappears says "nothing here" for both an empty period and a failed
  // request; only the empty half is an answer (§Обробка помилок).
  if (error) return <ErrorNote error={error} what={t("wd.title")} onRetry={refetch} />;
  if (!data) return null;

  const spentTotal = data.days.reduce((s, d) => s + d.spent, 0);
  if (spentTotal === 0) return null; // порожній період — блок не про історію, ховаємо

  const max = Math.max(...data.days.map((d) => d.typical), 1);
  // Тиждень починається з понеділка: `dow` іде за SQL (0 = неділя), а читач живе в тижні, що
  // починається з робочого дня. Порядок показу — питання читача, не бази.
  const ordered = [1, 2, 3, 4, 5, 6, 0].map((dow) => data.days.find((d) => d.dow === dow)!);

  return (
    <section>
      <div className="section-head">
        <h2>{t("wd.title")}</h2>
        <HoverTip content={<>{t("wd.tip")}</>}>
          <span className="label">{t("wd.subtitle")}</span>
        </HoverTip>
      </div>
      <div className="card" style={{ padding: 16 }}>
        <div className="wd-grid">
          {ordered.map((d) => {
            const weekend = d.dow === 0 || d.dow === 6;
            return (
              <div key={d.dow} className={`wd-col${weekend ? " weekend" : ""}`}>
                <div className="wd-bar-wrap">
                  {/* `lumpy` малюємо інакше, а не ховаємо: день, у якому вся сума — це оренда,
                      усе одно правда, просто не про поведінку. Сховати його означало б збрехати
                      про підсумок тижня. */}
                  <div
                    className={`wd-bar${d.lumpy ? " lumpy" : ""}${d.dow === data.busiest ? " busiest" : ""}`}
                    style={{ height: `${Math.round((d.typical / max) * 100)}%` }}
                    title={t("wd.barTitle", { n: d.n, days: d.days })}
                  />
                </div>
                <div className="wd-val num-mono">{formatMinor(d.typical, { decimals: false })}</div>
                <div className="wd-label label">{weekdayShort(d.dow)}</div>
              </div>
            );
          })}
        </div>
        <div className="wd-foot">
          {data.busiest != null && (
            <span>{t("wd.busiest", { day: weekdayShort(data.busiest) })}</span>
          )}
          {data.weekend_share_pct != null && (
            <span className="muted">{t("wd.weekendShare", { pct: data.weekend_share_pct })}</span>
          )}
        </div>
      </div>
    </section>
  );
}
