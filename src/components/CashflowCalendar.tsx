import { useMemo, useState } from "react";
import { getLocale, localeTag } from "../i18n/locale.ts";
import { useT } from "../i18n/index.ts";
import { useGetCashflowCalendarQuery } from "../store/api.ts";
import { formatMinor, currencySign } from "../lib/format.ts";
import { InfoTip } from "./InfoTip.tsx";
import { Icon } from "./Icon.tsx";

// Cashflow-календар: місячна сітка очікуваних списань (підписки/розстрочки) по днях +
// проєкція ліквідної подушки «наперед» → видно провали ліквідності. Дані — /analytics/cashflow-calendar.
// Пн-перший тиждень (2021-01-04 — понеділок). Рахуємо в рендері (не на модульному рівні),
// щоб живий перемикач мови одразу оновив підписи днів тижня.
const weekdayShort = (idx: number) => new Intl.DateTimeFormat(localeTag(getLocale()), { weekday: "short" }).format(new Date(2021, 0, 4 + idx));
const monthFmt = new Intl.DateTimeFormat(localeTag(getLocale()), { month: "long", year: "numeric" });
const dayFmt = new Intl.DateTimeFormat(localeTag(getLocale()), { day: "numeric", month: "short" });
const pad = (n: number) => String(n).padStart(2, "0");

interface DayItem { title: string; amount: number; amountOrig: number; currency: number; kind: string }
interface DayCell { total: number; items: DayItem[] }

export function CashflowCalendar() {
  const t = useT();
  const WD = Array.from({ length: 7 }, (_, i) => weekdayShort(i));
  const { data } = useGetCashflowCalendarQuery();
  const [offset, setOffset] = useState(0); // 0 = поточний місяць, 1 = наступний (вікно = 2 міс)
  const [open, setOpen] = useState<string | null>(null); // дата розкритого поповера

  // Списання по днях. Кілька входжень одного плану в один день склеюємо в рядок з ×N.
  const byDate = useMemo(() => {
    const m = new Map<string, DayCell>();
    for (const it of data?.items ?? []) {
      const e = m.get(it.date) ?? { total: 0, items: [] };
      e.total += it.amount;
      e.items.push({ title: it.title, amount: it.amount, amountOrig: it.amount_orig, currency: it.currency_code, kind: it.kind });
      m.set(it.date, e);
    }
    // Найдорожче списання дня — вгорі (воно й показується, коли місця мало).
    for (const e of m.values()) e.items.sort((a, b) => b.amount - a.amount);
    return m;
  }, [data]);

  // Проєкція подушки на кінець кожного дня, ОДНИМ проходом (раніше — O(n) на клітинку).
  const { balances, low } = useMemo(() => {
    const bal = new Map<string, number>();
    if (!data) return { balances: bal, low: null as null | { min: number; minDate: string } };
    let running = data.cushion, min = data.cushion, minDate = data.items[0]?.date ?? "";
    for (const it of data.items) {
      running -= it.amount;
      bal.set(it.date, running); // остання ітерація дня = баланс на кінець дня
      if (running < min) { min = running; minDate = it.date; }
    }
    return { balances: bal, low: { min, minDate } };
  }, [data]);

  if (!data) return <div className="card empty">{t("cfcal.calculating")}</div>;

  const base = new Date(data.now * 1000);
  const shown = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  const y = shown.getFullYear(), mo = shown.getMonth();
  const todayStr = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
  const daysIn = new Date(y, mo + 1, 0).getDate();
  const lead = (new Date(y, mo, 1).getDay() + 6) % 7; // Пн-перший
  const monthTotal = Array.from({ length: daysIn }, (_, i) => byDate.get(`${y}-${pad(mo + 1)}-${pad(i + 1)}`)?.total ?? 0).reduce((a, b) => a + b, 0);
  const maxDay = Math.max(1, ...Array.from(byDate.values()).map((v) => v.total));

  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: daysIn }, (_, i) => i + 1)];

  return (
    <div className="card cf-card">
      <div className="ai-head">
        <span className="ai-badge soft"><Icon name="calendar" size={18} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="ai-title">
            {t("cfcal.title")}
            <InfoTip>{t("cfcal.tip")}</InfoTip>
          </div>
          <div className="label">{t("cfcal.subtitle")}</div>
        </div>
        <div className="cf-nav">
          <button className="btn sm icon ghost" disabled={offset <= 0} onClick={() => setOffset((o) => o - 1)} aria-label={t("cfcal.prevMonthAria")}><Icon name="chevron" /></button>
          <span className="cf-month">{monthFmt.format(shown)}</span>
          <button className="btn sm icon ghost" disabled={offset >= 1} onClick={() => setOffset((o) => o + 1)} aria-label={t("cfcal.nextMonthAria")}><Icon name="chevron" /></button>
        </div>
      </div>

      {low && low.min < 0 && (
        <div className="cf-warn">{t("cfcal.warnNegative", { date: dayFmt.format(new Date(`${low.minDate}T00:00:00`)), amount: `${formatMinor(low.min, { decimals: false })} ₴` })}</div>
      )}

      <div className="cf-wd">{WD.map((d) => <span key={d}>{d}</span>)}</div>
      <div className="cf-grid">
        {cells.map((d, i) => {
          if (d == null) return <span key={`e${i}`} className="cf-day empty" />;
          const dateStr = `${y}-${pad(mo + 1)}-${pad(d)}`;
          const cell = byDate.get(dateStr);
          const bal = balances.get(dateStr) ?? null;
          const isToday = dateStr === todayStr;

          if (!cell) {
            return (
              <span key={dateStr} className={`cf-day ${isToday ? "today" : ""}`}>
                <span className="cf-dnum">{d}</span>
              </span>
            );
          }

          const intensity = 0.08 + 0.32 * (cell.total / maxDay);
          // Скільки списань вміщуємо прямо в клітинку (решта — «+N ще» і повний список у поповері).
          const INLINE = 2;
          const inline = cell.items.slice(0, INLINE);
          const rest = cell.items.length - inline.length;
          // Поповер біля правого краю тижня відкриваємо вліво, щоб не вилазив за картку.
          const col = i % 7;

          return (
            <button
              key={dateStr}
              type="button"
              className={`cf-day has ${isToday ? "today" : ""} ${bal != null && bal < 0 ? "danger" : ""} ${open === dateStr ? "open" : ""}`}
              style={{ background: `color-mix(in srgb, var(--neg) ${Math.round(intensity * 100)}%, var(--surface))` }}
              aria-label={t("cfcal.dayAria", { date: dayFmt.format(new Date(`${dateStr}T00:00:00`)), count: cell.items.length, amount: `${formatMinor(cell.total, { decimals: false })} ₴` })}
              onMouseEnter={() => setOpen(dateStr)}
              onMouseLeave={() => setOpen((o) => (o === dateStr ? null : o))}
              onFocus={() => setOpen(dateStr)}
              onBlur={() => setOpen((o) => (o === dateStr ? null : o))}
              onClick={() => setOpen((o) => (o === dateStr ? null : dateStr))}
            >
              <span className="cf-dhead">
                <span className="cf-dnum">{d}</span>
                <span className="cf-damt">−{formatMinor(cell.total, { decimals: false })}</span>
              </span>

              {/* Назви списань прямо в дні — щоб не треба було наводити заради «що це». */}
              <span className="cf-items">
                {inline.map((it, k) => (
                  <span className="cf-item" key={k}>
                    <span className="cf-item-name">{it.title}</span>
                    <span className="cf-item-amt">{formatMinor(it.amount, { decimals: false })}</span>
                  </span>
                ))}
                {rest > 0 && <span className="cf-item more">{t("cfcal.moreItems", { n: rest })}</span>}
              </span>

              {open === dateStr && (
                <span className={`cf-pop ${col >= 5 ? "left" : ""}`} role="tooltip">
                  <span className="cf-pop-head">{dayFmt.format(new Date(`${dateStr}T00:00:00`))}</span>
                  {cell.items.map((it, k) => (
                    <span className="cf-pop-row" key={k}>
                      <span className="cf-pop-name">{it.title}</span>
                      {/* Валютний план: показуємо суму у валюті + ₴-еквівалент (сітка рахує в ₴). */}
                      <span className="cf-pop-amt">
                        −{formatMinor(it.amount, { decimals: false })} ₴
                        {it.currency !== 980 && <span className="cf-pop-orig"> ({formatMinor(it.amountOrig, { decimals: false })} {currencySign(it.currency)})</span>}
                      </span>
                    </span>
                  ))}
                  <span className="cf-pop-foot">
                    <span>{t("cfcal.dayTotal")}</span>
                    <b>−{formatMinor(cell.total, { decimals: false })} ₴</b>
                  </span>
                  {bal != null && (
                    <span className={`cf-pop-bal ${bal < 0 ? "neg" : ""}`}>
                      {t("cfcal.cushionAfter", { amount: `${formatMinor(bal, { decimals: false })} ₴` })}
                    </span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="cf-foot">
        <span>{t("cfcal.monthTotal")} <b>{formatMinor(monthTotal, { decimals: false })} ₴</b></span>
        <span className="muted">{t("cfcal.cushionStart", { amount: `${formatMinor(data.cushion, { decimals: false })} ₴` })}</span>
      </div>
    </div>
  );
}
