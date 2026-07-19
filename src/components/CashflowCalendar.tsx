import { useMemo, useState } from "react";
import { useGetCashflowCalendarQuery } from "../store/api.ts";
import { formatMinor } from "../lib/format.ts";
import { InfoTip } from "./InfoTip.tsx";
import { Icon } from "./Icon.tsx";

// Cashflow-календар: місячна сітка очікуваних списань (підписки/розстрочки) по днях +
// проєкція ліквідної подушки «наперед» → видно провали ліквідності. Дані — /analytics/cashflow-calendar.
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const monthFmt = new Intl.DateTimeFormat("uk-UA", { month: "long", year: "numeric" });
const dayFmt = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short" });
const pad = (n: number) => String(n).padStart(2, "0");

export function CashflowCalendar() {
  const { data } = useGetCashflowCalendarQuery();
  const [offset, setOffset] = useState(0); // 0 = поточний місяць, 1 = наступний (вікно = 2 міс)

  const byDate = useMemo(() => {
    const m = new Map<string, { total: number; titles: string[] }>();
    for (const it of data?.items ?? []) {
      const e = m.get(it.date) ?? { total: 0, titles: [] };
      e.total += it.amount; e.titles.push(it.title);
      m.set(it.date, e);
    }
    return m;
  }, [data]);

  // Проєкція балансу на кінець дня = подушка − сума списань до цього дня включно.
  const balanceAt = (dateStr: string) => {
    if (!data) return 0;
    let b = data.cushion;
    for (const it of data.items) if (it.date <= dateStr) b -= it.amount;
    return b;
  };
  // Найнижча точка балансу за все вікно (для попередження).
  const low = useMemo(() => {
    if (!data) return null;
    let bal = data.cushion, min = data.cushion, minDate = data.items[0]?.date ?? "";
    for (const it of data.items) { bal -= it.amount; if (bal < min) { min = bal; minDate = it.date; } }
    return { min, minDate };
  }, [data]);

  if (!data) return <div className="card empty">Рахуємо…</div>;

  const base = new Date(data.now * 1000);
  const shown = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  const y = shown.getFullYear(), mo = shown.getMonth();
  const todayStr = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
  const daysIn = new Date(y, mo + 1, 0).getDate();
  const lead = (new Date(y, mo, 1).getDay() + 6) % 7; // Пн-первий
  const monthTotal = Array.from({ length: daysIn }, (_, i) => byDate.get(`${y}-${pad(mo + 1)}-${pad(i + 1)}`)?.total ?? 0).reduce((a, b) => a + b, 0);
  const maxDay = Math.max(1, ...Array.from(byDate.values()).map((v) => v.total));

  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: daysIn }, (_, i) => i + 1)];

  return (
    <div className="card cf-card">
      <div className="ai-head">
        <span className="ai-badge soft"><Icon name="calendar" size={18} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="ai-title">
            Cashflow-календар
            <InfoTip>Очікувані списання (підписки/розстрочки) по днях + проєкція ліквідної подушки наперед. Видно, коли платежі згущуються й баланс просідає. Планового доходу тут ще нема.</InfoTip>
          </div>
          <div className="label">списання й провали ліквідності наперед</div>
        </div>
        <div className="cf-nav">
          <button className="btn sm icon ghost" disabled={offset <= 0} onClick={() => setOffset((o) => o - 1)} aria-label="Попередній місяць"><Icon name="chevron" /></button>
          <span className="cf-month">{monthFmt.format(shown)}</span>
          <button className="btn sm icon ghost" disabled={offset >= 1} onClick={() => setOffset((o) => o + 1)} aria-label="Наступний місяць"><Icon name="chevron" /></button>
        </div>
      </div>

      {low && low.min < 0 && (
        <div className="cf-warn">⚠️ Прогноз балансу йде в мінус до {dayFmt.format(new Date(`${low.minDate}T00:00:00`))}: {formatMinor(low.min, { decimals: false })} ₴. Прибери/перенеси необов'язкові списання.</div>
      )}

      <div className="cf-wd">{WD.map((d) => <span key={d}>{d}</span>)}</div>
      <div className="cf-grid">
        {cells.map((d, i) => {
          if (d == null) return <span key={`e${i}`} className="cf-day empty" />;
          const dateStr = `${y}-${pad(mo + 1)}-${pad(d)}`;
          const cell = byDate.get(dateStr);
          const bal = cell ? balanceAt(dateStr) : null;
          const intensity = cell ? 0.08 + 0.32 * (cell.total / maxDay) : 0;
          return (
            <span
              key={dateStr}
              className={`cf-day ${dateStr === todayStr ? "today" : ""} ${bal != null && bal < 0 ? "danger" : ""}`}
              style={cell ? { background: `color-mix(in srgb, var(--neg) ${Math.round(intensity * 100)}%, var(--surface))` } : undefined}
              title={cell ? `${dayFmt.format(new Date(`${dateStr}T00:00:00`))}: ${formatMinor(cell.total, { decimals: false })} ₴\n${cell.titles.join(", ")}` : undefined}
            >
              <span className="cf-dnum">{d}</span>
              {cell && <span className="cf-damt">−{formatMinor(cell.total, { decimals: false })}</span>}
            </span>
          );
        })}
      </div>

      <div className="cf-foot">
        <span>Списань цього місяця: <b>{formatMinor(monthTotal, { decimals: false })} ₴</b></span>
        <span className="muted">старт подушки {formatMinor(data.cushion, { decimals: false })} ₴</span>
      </div>
    </div>
  );
}
