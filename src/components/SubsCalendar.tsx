import { useGetUpcomingSubsQuery } from "../store/api.ts";
import { formatMinor } from "../lib/format.ts";
import { HoverTip } from "./HoverTip.tsx";

// §Беклог: календар майбутніх списань — сітка на ~5 тижнів наперед, дні з підписками
// підсвічені сумою. Дає побачити «важкі» дні місяця й вплив на кешфлоу.
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const DAY = 86400;

function dayKey(unix: number): string {
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function SubsCalendar() {
  const { data } = useGetUpcomingSubsQuery(34);
  if (!data || data.items.length === 0) return null;

  // Групуємо суми/назви за днем.
  const byDay = new Map<string, { sum: number; titles: string[] }>();
  for (const it of data.items) {
    const k = dayKey(it.at);
    const cur = byDay.get(k) ?? { sum: 0, titles: [] };
    cur.sum += it.amount; cur.titles.push(it.title);
    byDay.set(k, cur);
  }

  // Сітка від понеділка поточного тижня, поки не покриємо today+34 дн.
  const now = new Date();
  const todayKey = dayKey(Math.floor(now.getTime() / 1000));
  const startMonday = new Date(now);
  startMonday.setHours(0, 0, 0, 0);
  startMonday.setDate(startMonday.getDate() - ((now.getDay() + 6) % 7)); // Пн=0
  const endUnix = Math.floor(now.getTime() / 1000) + 34 * DAY;
  const cells: Date[] = [];
  const cur = new Date(startMonday);
  while (Math.floor(cur.getTime() / 1000) <= endUnix || cells.length % 7 !== 0) {
    cells.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
    if (cells.length > 49) break; // запобіжник (7 тижнів max)
  }

  return (
    <section>
      <div className="section-head">
        <h2>Календар списань</h2>
        <span className="label">за 34 дні · {formatMinor(data.total, { decimals: false })} ₴</span>
      </div>
      <div className="card subs-cal">
        <div className="sc-grid sc-head">
          {WD.map((w) => <div key={w} className="sc-wd">{w}</div>)}
        </div>
        <div className="sc-grid">
          {cells.map((d, i) => {
            const k = dayKey(Math.floor(d.getTime() / 1000));
            const hit = byDay.get(k);
            const isToday = k === todayKey;
            const past = Math.floor(d.getTime() / 1000) < Math.floor(now.getTime() / 1000) - DAY && !isToday;
            const weekend = d.getDay() === 0 || d.getDay() === 6;
            const cell = (
              <div className={`sc-cell ${hit ? "has" : ""} ${isToday ? "today" : ""} ${past ? "past" : ""} ${weekend ? "weekend" : ""}`}>
                <span className="sc-day">{d.getDate()}</span>
                {hit && (
                  <div className="sc-hit">
                    <span className="sc-title">{hit.titles[0]}{hit.titles.length > 1 ? ` +${hit.titles.length - 1}` : ""}</span>
                    <span className="sc-amt">{formatMinor(hit.sum, { decimals: false })} ₴</span>
                  </div>
                )}
              </div>
            );
            return hit
              ? <HoverTip key={i} content={<><div className="tip-lbl">{d.getDate()}.{d.getMonth() + 1} · {formatMinor(hit.sum, { decimals: false })} ₴</div>{hit.titles.map((t, j) => <div key={j} className="r">{t}</div>)}</>}>{cell}</HoverTip>
              : <div key={i}>{cell}</div>;
          })}
        </div>
      </div>
    </section>
  );
}
