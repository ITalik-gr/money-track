import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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

/**
 * The day popover, rendered into `document.body` and placed against the day's rectangle.
 *
 * ⚠️ It used to be an absolutely positioned child of the day cell, inside `.cf-grid`, which has
 * `overflow: hidden` (the rounded canvas needs it). So a popover that opened below a day in the last
 * row — or past the card's edge — was simply CUT OFF, and the days at the edges were exactly the ones
 * a person checks at the end of a month (owner, 2026-09-25: «попап міні обрізається якщо виходить
 * за межі календаря»). The old `.left` flip handled only the right edge of the week.
 *
 * Now: measured after mount, placed below the day, flipped ABOVE when the viewport has no room
 * below, and clamped horizontally to the viewport with an 8px gutter — which also covers a 400px
 * phone. `position: fixed`, so it closes on scroll rather than drifting away from its day.
 */
function DayPopover({ anchor, children }: { anchor: DOMRect; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const GAP = 6, EDGE = 8;
    const below = anchor.bottom + GAP;
    const top = below + height > window.innerHeight - EDGE && anchor.top - GAP - height >= EDGE
      ? anchor.top - GAP - height
      : Math.min(below, Math.max(EDGE, window.innerHeight - EDGE - height));
    const left = Math.min(Math.max(EDGE, anchor.left), Math.max(EDGE, window.innerWidth - EDGE - width));
    setPos({ top, left });
  }, [anchor]);
  return createPortal(
    <span ref={ref} className="cf-pop" role="tooltip"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden" }}>
      {children}
    </span>,
    document.body,
  );
}

export function CashflowCalendar() {
  const t = useT();
  const WD = Array.from({ length: 7 }, (_, i) => weekdayShort(i));
  const { data, error, refetch } = useGetCashflowCalendarQuery();
  // 0 = поточний місяць. Вікно задає СЕРВЕР (`/analytics/cashflow-calendar` віддає 3 місяці
  // вперед одним шматком, бо проєкція подушки — це наскрізне віднімання). Клієнт не вдає, що
  // вміє гортати далі, ніж є дані: порожній місяць читався б як «списань більше не буде».
  const [offset, setOffset] = useState(0);
  // The open day and the rectangle its popover is placed against (§ DayPopover).
  const [open, setOpenState] = useState<{ date: string; rect: DOMRect } | null>(null);
  const openAt = (date: string, el: HTMLElement) => setOpenState({ date, rect: el.getBoundingClientRect() });
  const closeIf = (date: string) => setOpenState((o) => (o?.date === date ? null : o));
  // A fixed popover does not follow a scrolling page; closing it is honest, drifting is not.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpenState(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [open]);

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

          return (
            <button
              key={dateStr}
              type="button"
              className={`cf-day has ${isToday ? "today" : ""} ${weekend ? "wknd" : ""} ${bal != null && bal < 0 ? "danger" : ""} ${open?.date === dateStr ? "open" : ""}`}
              style={{ background: `color-mix(in srgb, var(--neg) ${Math.round(intensity * 100)}%, var(--surface))` }}
              aria-label={t("cfcal.dayAria", { date: dayFmt.format(new Date(`${dateStr}T00:00:00`)), count: cell.items.length, amount: `${formatMinor(cell.total, { decimals: false })} ${baseSign()}` })}
              aria-expanded={open?.date === dateStr}
              onMouseEnter={(e) => openAt(dateStr, e.currentTarget)}
              onMouseLeave={() => closeIf(dateStr)}
              onFocus={(e) => openAt(dateStr, e.currentTarget)}
              onBlur={() => closeIf(dateStr)}
              onClick={(e) => (open?.date === dateStr ? setOpenState(null) : openAt(dateStr, e.currentTarget))}
              onKeyDown={(e) => { if (e.key === "Escape") setOpenState(null); }}
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

              {open?.date === dateStr && (
                <DayPopover anchor={open.rect}>
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
                </DayPopover>
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
