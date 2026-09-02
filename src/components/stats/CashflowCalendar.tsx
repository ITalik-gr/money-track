import { useMemo, useState } from "react";
import { dateFmt } from "../../i18n/locale.ts";
import { useT } from "../../i18n/index.ts";
import { useGetCashflowCalendarQuery } from "../../store/api.ts";
import { formatMinor, currencySign } from "../../lib/format.ts";
import { InfoTip } from "../ui/InfoTip.tsx";
import { Icon } from "../ui/Icon.tsx";
import { ErrorNote } from "../ui/ErrorNote.tsx";
import { baseSign, getBaseCurrency } from "../../lib/currency.ts";

// Cashflow-календар: місячна сітка очікуваних списань (підписки/розстрочки) по днях +
// проєкція ліквідної подушки «наперед» → видно провали ліквідності. Дані — /analytics/cashflow-calendar.
// Пн-перший тиждень (2021-01-04 — понеділок). Рахуємо в рендері (не на модульному рівні),
// щоб живий перемикач мови одразу оновив підписи днів тижня.
const weekdayShort = (idx: number) => dateFmt({ weekday: "short" }).format(new Date(2021, 0, 4 + idx));
const monthFmt = dateFmt({ month: "long", year: "numeric" });
const dayFmt = dateFmt({ day: "numeric", month: "short" });
const pad = (n: number) => String(n).padStart(2, "0");
const MAX_OFFSET = 2; // сервер віддає поточний + два наступні

interface DayItem { title: string; amount: number; amountOrig: number; currency: number; kind: string }
interface DayCell { total: number; items: DayItem[] }

export function CashflowCalendar() {
  const t = useT();
  const WD = Array.from({ length: 7 }, (_, i) => weekdayShort(i));
  const { data, error, refetch } = useGetCashflowCalendarQuery();
  // 0 = поточний місяць. Вікно задає СЕРВЕР (`/analytics/cashflow-calendar` віддає 3 місяці
  // вперед одним шматком, бо проєкція подушки — це наскрізне віднімання). Клієнт не вдає, що
  // вміє гортати далі, ніж є дані: порожній місяць читався б як «списань більше не буде».
  const [offset, setOffset] = useState(0);
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

  // Worse than vanishing: with no answer this block used to sit on «Рахуємо…» forever, claiming
  // work is still in progress when the request is already dead (§Обробка помилок).
  if (error) return <ErrorNote error={error} what={t("cfcal.title")} onRetry={refetch} />;
  if (!data) return <div className="card empty">{t("cfcal.calculating")}</div>;

  const base = new Date(data.now * 1000);
  const shown = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  const y = shown.getFullYear(), mo = shown.getMonth();
  const todayStr = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
  const daysIn = new Date(y, mo + 1, 0).getDate();
  const lead = (new Date(y, mo, 1).getDay() + 6) % 7; // Пн-перший
  const monthTotal = Array.from({ length: daysIn }, (_, i) => byDate.get(`${y}-${pad(mo + 1)}-${pad(i + 1)}`)?.total ?? 0).reduce((a, b) => a + b, 0);
  const maxDay = Math.max(1, ...Array.from(byDate.values()).map((v) => v.total));

  // Leading and trailing days of the NEIGHBOURING months are drawn muted rather than left as
  // holes: a calendar whose first row starts in mid-air reads as a broken grid, and the reader
  // needs to see that the 1st is a Tuesday relative to something.
  const prevDays = new Date(y, mo, 0).getDate();
  const trail = (7 - ((lead + daysIn) % 7)) % 7;
  const cells: { d: number; out: boolean }[] = [
    ...Array.from({ length: lead }, (_, i) => ({ d: prevDays - lead + 1 + i, out: true })),
    ...Array.from({ length: daysIn }, (_, i) => ({ d: i + 1, out: false })),
    ...Array.from({ length: trail }, (_, i) => ({ d: i + 1, out: true })),
  ];

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
        {/* One control, not two chevrons with a label wedged between them: the month and the two
            ways to move it belong together, and split apart they read as three unrelated buttons.
            «Сьогодні» appears only when it would do something — a control that is always there and
            usually a no-op is the `budgets.rollover` mistake in miniature. */}
        <div className="cf-nav">
          <button className="cf-nav-btn" disabled={offset <= 0} onClick={() => setOffset((o) => o - 1)} aria-label={t("cfcal.prevMonthAria")}>
            <Icon name="chevron" size={16} />
          </button>
          <span className="cf-month">{monthFmt.format(shown)}</span>
          <button className="cf-nav-btn next" disabled={offset >= MAX_OFFSET} onClick={() => setOffset((o) => o + 1)} aria-label={t("cfcal.nextMonthAria")}>
            <Icon name="chevron" size={16} />
          </button>
          {offset !== 0 && <button className="cf-today" onClick={() => setOffset(0)}>{t("cfcal.today")}</button>}
        </div>
      </div>

      {low && low.min < 0 && (
        <div className="cf-warn">{t("cfcal.warnNegative", { date: dayFmt.format(new Date(`${low.minDate}T00:00:00`)), amount: `${formatMinor(low.min, { decimals: false })} ${baseSign()}` })}</div>
      )}

      <div className="cf-wd">{WD.map((d) => <span key={d}>{d}</span>)}</div>
      <div className="cf-grid">
        {cells.map(({ d, out }, i) => {
          if (out) return <span key={`o${i}`} className="cf-day out"><span className="cf-dnum">{d}</span></span>;
          const dateStr = `${y}-${pad(mo + 1)}-${pad(d)}`;
          const weekend = i % 7 >= 5;
          const cell = byDate.get(dateStr);
          const bal = balances.get(dateStr) ?? null;
          const isToday = dateStr === todayStr;

          if (!cell) {
            return (
              <span key={dateStr} className={`cf-day ${isToday ? "today" : ""} ${weekend ? "wknd" : ""}`}>
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
              className={`cf-day has ${isToday ? "today" : ""} ${weekend ? "wknd" : ""} ${bal != null && bal < 0 ? "danger" : ""} ${open === dateStr ? "open" : ""}`}
              style={{ background: `color-mix(in srgb, var(--neg) ${Math.round(intensity * 100)}%, var(--surface))` }}
              aria-label={t("cfcal.dayAria", { date: dayFmt.format(new Date(`${dateStr}T00:00:00`)), count: cell.items.length, amount: `${formatMinor(cell.total, { decimals: false })} ${baseSign()}` })}
              onMouseEnter={() => setOpen(dateStr)}
              onMouseLeave={() => setOpen((o) => (o === dateStr ? null : o))}
              onFocus={() => setOpen(dateStr)}
              onBlur={() => setOpen((o) => (o === dateStr ? null : o))}
              onClick={() => setOpen((o) => (o === dateStr ? null : dateStr))}
            >
              <span className="cf-dhead">
                <span className="cf-dnum">{d}</span>
                {/* §INCOME-PLAN: the sign is DERIVED, never hardcoded. Income arrives as a
                    negative `amount` (so the running balance is one subtraction), which means a
                    day that nets positive must read "+" — a literal "−" in front of it printed
                    "−−5 000" and turned payday into the worst day of the month. */}
                <span className={`cf-damt ${cell.total < 0 ? "in" : ""}`}>
                  {cell.total < 0 ? "+" : "−"}{formatMinor(Math.abs(cell.total), { decimals: false })}
                </span>
              </span>

              {/* Назви списань прямо в дні — щоб не треба було наводити заради «що це». */}
              <span className="cf-items">
                {inline.map((it, k) => (
                  <span className="cf-item" key={k}>
                    <span className="cf-item-name">{it.title}</span>
                    <span className={`cf-item-amt ${it.amount < 0 ? "in" : ""}`}>
                      {it.amount < 0 ? "+" : ""}{formatMinor(Math.abs(it.amount), { decimals: false })}
                    </span>
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
                      <span className={`cf-pop-amt ${it.amount < 0 ? "in" : ""}`}>
                        {it.amount < 0 ? "+" : "−"}{formatMinor(Math.abs(it.amount), { decimals: false })} {baseSign()}
                        {it.currency !== getBaseCurrency() && <span className="cf-pop-orig"> ({formatMinor(Math.abs(it.amountOrig), { decimals: false })} {currencySign(it.currency)})</span>}
                      </span>
                    </span>
                  ))}
                  <span className="cf-pop-foot">
                    <span>{t("cfcal.dayTotal")}</span>
                    <b className={cell.total < 0 ? "in" : ""}>
                      {cell.total < 0 ? "+" : "−"}{formatMinor(Math.abs(cell.total), { decimals: false })} {baseSign()}
                    </b>
                  </span>
                  {bal != null && (
                    <span className={`cf-pop-bal ${bal < 0 ? "neg" : ""}`}>
                      {t("cfcal.cushionAfter", { amount: `${formatMinor(bal, { decimals: false })} ${baseSign()}` })}
                    </span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="cf-foot">
        <span>{t("cfcal.monthTotal")} <b>{formatMinor(monthTotal, { decimals: false })} {baseSign()}</b></span>
        <span className="muted">{t("cfcal.cushionStart", { amount: `${formatMinor(data.cushion, { decimals: false })} ${baseSign()}` })}</span>
      </div>
    </div>
  );
}
