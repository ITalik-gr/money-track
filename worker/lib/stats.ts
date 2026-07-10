// §Аналітика 2.0 — ЄДИНЕ джерело правди для визначення «витрати/доходу» та зведення в ₴.
// Використовується в усіх /analytics-ендпоінтах, forecast, AI-контексті та репортах,
// щоб цифри UI = цифри AI = цифри репорту. Правила (узгоджено з користувачем):
//   • витрата: amount<0, НЕ пара-переказ, НЕ незакритий рух власних коштів,
//     ефективна категорія ≠ «Перекази і зняття» (13); holds рахуються (див. SPEND_WHERE);
//   • ефективна категорія = рол-ап real_category_id (готівка/зняття за реальною суттю),
//     інакше рол-ап звичайної category_id;
//   • зведення валют у ₴ через курси (inline CASE), опційно — «чиста» валюта.
import type { Rates } from "./finance.ts";
import type { Env } from "../env.ts";

export const TRANSFER_CAT = 13; // «Перекази і зняття» (+ діти через рол-ап)

// Джоїни, потрібні для рол-апу і звичайної, і реальної категорії. Очікує alias `t`.
export const STATS_JOINS = `
  LEFT JOIN categories c  ON c.id  = t.category_id
  LEFT JOIN categories p  ON p.id  = c.parent_id
  LEFT JOIN categories rc ON rc.id = t.real_category_id
  LEFT JOIN categories rp ON rp.id = rc.parent_id`;

// Ефективна категорія (рол-ап у батька): спершу реальна (для зняття/переказів із
// визначеною суттю), інакше звичайна. NULL = без категорії (рахуємо як витрату).
export const EFF_CAT_ID = "COALESCE(rp.id, rc.id, p.id, c.id)";
export const EFF_CAT_NAME = "COALESCE(rp.name, rc.name, p.name, c.name)";
export const EFF_CAT_COLOR = "COALESCE(rp.color, rc.color, p.color, c.color)";

// §6 Вагомість: override операції → вагомість ефективної категорії (рол-ап) → дефолт 'discretionary'.
// Потребує STATS_JOINS (c/p/rc/rp). Значення: essential|discretionary|optional.
export const EFF_IMPORTANCE = "COALESCE(t.importance, rp.importance, rc.importance, p.importance, c.importance, 'discretionary')";

// Канонічний фільтр витрати. `IS NOT 13` (а не `!= 13`) — щоб NULL-категорія (без
// категорії) все одно рахувалась як витрата; лише явний бакет 13 виключається.
// Holds НЕ виключаємо: monobank надсилає лише реальні (виконані) операції, а коли hold
// закривається — той самий id перезаписується (repo.ts). Тому held-рядок = справжня
// витрата; інакше свіжий тиждень/місяць у репорті/Статистиці порожній, хоча в списку
// транзакцій операції є (той список holds показує). Прапорець `hold` лишається для UI-бейджа.
export const SPEND_WHERE = `
  t.amount < 0
  AND t.transfer_pair_id IS NULL
  AND NOT (t.is_transfer = 1 AND t.real_category_id IS NULL)
  AND ${EFF_CAT_ID} IS NOT ${TRANSFER_CAT}`;

// Канонічний фільтр доходу: надходження, не пара-переказ, не рух власних (holds — див. SPEND_WHERE).
export const INCOME_WHERE = `
  t.amount > 0 AND t.transfer_pair_id IS NULL AND t.is_transfer = 0`;

// Множник зведення в ₴ для поточного рядка (inline CASE з курсів). 980→1.0; кожен
// відомий код → його курс (₴ за одиницю-мінор, як у toUAHMinor); невідомий → 0.
export function uahMult(rates: Rates, col = "t.currency_code"): string {
  const parts = ["WHEN 980 THEN 1.0"];
  for (const [code, rate] of Object.entries(rates)) {
    if (code === "980") continue;
    if (Number.isFinite(rate) && rate > 0) parts.push(`WHEN ${Number(code)} THEN ${rate}`);
  }
  return `(CASE ${col} ${parts.join(" ")} ELSE 0 END)`;
}

// Режим значення: зведення в ₴ (дефолт) або «чиста» валюта (currency=NNN → множник 1,
// плюс фільтр по валюті). Повертає готовий множник і фрагмент WHERE (може бути порожній).
export function valueMode(rates: Rates, currency?: number | null): { mult: string; curFilter: string } {
  if (currency && currency !== 0) return { mult: "1.0", curFilter: ` AND t.currency_code = ${Math.trunc(currency)}` };
  return { mult: uahMult(rates), curFilter: "" };
}

// Готові SUM-вирази із ВБУДОВАНИМ канонічним фільтром (тому totals — один запит; запит
// має включати STATS_JOINS). `mult` — з valueMode(). Округлено, знак витрати додатний.
export function spendSum(mult: string): string {
  return `CAST(ROUND(COALESCE(SUM(CASE WHEN ${SPEND_WHERE} THEN (-t.amount) * ${mult} ELSE 0 END), 0)) AS INTEGER)`;
}
export function incomeSum(mult: string): string {
  return `CAST(ROUND(COALESCE(SUM(CASE WHEN ${INCOME_WHERE} THEN t.amount * ${mult} ELSE 0 END), 0)) AS INTEGER)`;
}
export const SPEND_COUNT = `SUM(CASE WHEN ${SPEND_WHERE} THEN 1 ELSE 0 END)`;
export const INCOME_COUNT = `SUM(CASE WHEN ${INCOME_WHERE} THEN 1 ELSE 0 END)`;
// Сума однієї канонічної гілки (byCategory/byMerchant — SPEND_WHERE уже у WHERE рядка).
export function amountSum(mult: string): string {
  return `CAST(ROUND(COALESCE(SUM((-t.amount) * ${mult}), 0)) AS INTEGER)`;
}

// ---- §E1: Разові vs регулярні (канонічно) -----------------------------------
// «Регулярний» мерчант = має витрати у ≥RECUR_MIN_MONTHS РІЗНИХ календарних місяцях у
// трейлінг-референс-вікні. Це відділяє звичні щомісячні витрати (продукти, транспорт,
// підписки) від разових (податки, стоматолог, велика покупка), щоб «нормальний» місячний
// burn не спотворювався викидами. Детерміновано, без AI. Мерчант NULL → разове.
export const RECUR_MIN_MONTHS = 3;

// Підзапит мерчантів, що кваліфікуються як регулярні (легкий фільтр — рекуренція евристична).
function recurringMerchantsSubquery(refFrom: number, to: number): string {
  return `SELECT merchant FROM transactions
    WHERE time >= ${Math.trunc(refFrom)} AND time <= ${Math.trunc(to)}
      AND amount < 0 AND transfer_pair_id IS NULL AND is_transfer = 0
      AND merchant IS NOT NULL AND merchant <> ''
    GROUP BY merchant
    HAVING COUNT(DISTINCT strftime('%Y-%m', time, 'unixepoch')) >= ${RECUR_MIN_MONTHS}`;
}
// Булевий вираз «поточний рядок t — регулярний» (для CASE/фільтрів). Потребує alias `t`.
export function isRecurringExpr(refFrom: number, to: number): string {
  return `(t.merchant IS NOT NULL AND t.merchant IN (${recurringMerchantsSubquery(refFrom, to)}))`;
}

export interface SplitBucket { spent: number; n: number }
export interface OneoffItem { merchant: string | null; category: string | null; amount: number; time: number }
export interface RecurringSplit {
  ref_from: number;
  recurring: SplitBucket;
  oneoff: SplitBucket;
  oneoff_items: OneoffItem[];  // найбільші разові витрати періоду
}

// Референс-вікно за замовчуванням — 6 календарних місяців назад від `to` (щоб було з чого
// рахувати «≥3 місяці»).
export function defaultRefFrom(to: number): number {
  const d = new Date(to * 1000);
  return Math.floor(new Date(d.getFullYear(), d.getMonth() - 5, 1).getTime() / 1000);
}

// Канонічний split витрат періоду на регулярні/разові + топ разових. Зведено в ₴ (mult).
export async function recurringOneoffSplit(
  env: Env, from: number, to: number, mult: string, refFrom = defaultRefFrom(to),
): Promise<RecurringSplit> {
  const recur = isRecurringExpr(refFrom, to);
  const [split, items] = await Promise.all([
    env.DB.prepare(
      `SELECT CASE WHEN ${recur} THEN 'recurring' ELSE 'oneoff' END AS kind,
              ${amountSum(mult)} AS spent, COUNT(*) AS n
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
       GROUP BY kind`,
    ).bind(from, to).all<{ kind: string; spent: number; n: number }>(),
    env.DB.prepare(
      `SELECT t.merchant AS merchant, ${EFF_CAT_NAME} AS category,
              CAST(ROUND((-t.amount) * ${mult}) AS INTEGER) AS amount, t.time AS time
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE} AND NOT ${recur}
       ORDER BY amount DESC LIMIT 6`,
    ).bind(from, to).all<OneoffItem>(),
  ]);
  const get = (k: string): SplitBucket => {
    const r = (split.results ?? []).find((x) => x.kind === k);
    return { spent: r?.spent ?? 0, n: r?.n ?? 0 };
  };
  return { ref_from: refFrom, recurring: get("recurring"), oneoff: get("oneoff"), oneoff_items: items.results ?? [] };
}

// ---- Періоди (календарний ⇄ ковзний) ----------------------------------------
export type PeriodMode = "calendar" | "rolling";
export type Preset = "week" | "month" | "quarter" | "year";

export interface Bounds { from: number; to: number; prevFrom: number; prevTo: number; bucket: "day" | "week" | "month" }

const DAY = 86400;
const u = (d: Date) => Math.floor(d.getTime() / 1000);

// Межі періоду + рівний попередній (для «vs минулий»). Календарний = природні межі
// циклу; ковзний = останні N днів. `now` — верхня межа (звичайно поточний час).
export function periodBounds(mode: PeriodMode, preset: Preset, now = Math.floor(Date.now() / 1000)): Bounds {
  const d = new Date(now * 1000);
  const bucket: Bounds["bucket"] = preset === "year" ? "month" : preset === "quarter" ? "week" : "day";

  if (mode === "rolling") {
    const days = preset === "week" ? 7 : preset === "month" ? 30 : preset === "quarter" ? 90 : 365;
    const from = now - days * DAY;
    return { from, to: now, prevFrom: from - days * DAY, prevTo: from, bucket };
  }

  // Календарний.
  if (preset === "week") {
    // ISO-тиждень: понеділок 00:00.
    const dow = (d.getDay() + 6) % 7; // 0=Пн
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
    const from = u(start);
    const prevFrom = u(new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7));
    return { from, to: now, prevFrom, prevTo: from, bucket };
  }
  if (preset === "month") {
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const prevStart = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    return { from: u(start), to: now, prevFrom: u(prevStart), prevTo: u(start), bucket };
  }
  if (preset === "quarter") {
    const q = Math.floor(d.getMonth() / 3);
    const start = new Date(d.getFullYear(), q * 3, 1);
    const prevStart = new Date(d.getFullYear(), q * 3 - 3, 1);
    return { from: u(start), to: now, prevFrom: u(prevStart), prevTo: u(start), bucket };
  }
  // year
  const start = new Date(d.getFullYear(), 0, 1);
  const prevStart = new Date(d.getFullYear() - 1, 0, 1);
  return { from: u(start), to: now, prevFrom: u(prevStart), prevTo: u(start), bucket };
}

// Поточний період ДО сьогодні (для ручної генерації/тесту — дані, які видно зараз).
// Попередній — той самий відрізок минулого циклу (чесний MTD).
export function currentPeriodToDate(preset: "week" | "month", now = Math.floor(Date.now() / 1000)): { from: number; to: number; prevFrom: number; prevTo: number } {
  const d = new Date(now * 1000);
  let start: Date, prevStart: Date;
  if (preset === "week") {
    const dow = (d.getDay() + 6) % 7;
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
    prevStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7);
  } else {
    start = new Date(d.getFullYear(), d.getMonth(), 1);
    prevStart = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  }
  const from = u(start);
  const elapsed = now - from;
  const prevFrom = u(prevStart);
  return { from, to: now, prevFrom, prevTo: prevFrom + elapsed };
}

// Повні (закриті) межі попереднього періоду — для репортів «за минулий тиждень/місяць».
export function lastCompletePeriod(preset: "week" | "month", now = Math.floor(Date.now() / 1000)): { from: number; to: number; prevFrom: number; prevTo: number } {
  const d = new Date(now * 1000);
  if (preset === "week") {
    const dow = (d.getDay() + 6) % 7;
    const thisStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
    const from = u(new Date(thisStart.getFullYear(), thisStart.getMonth(), thisStart.getDate() - 7));
    const to = u(thisStart);
    const prevFrom = u(new Date(thisStart.getFullYear(), thisStart.getMonth(), thisStart.getDate() - 14));
    return { from, to, prevFrom, prevTo: from };
  }
  const thisStart = new Date(d.getFullYear(), d.getMonth(), 1);
  const from = u(new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const to = u(thisStart);
  const prevFrom = u(new Date(d.getFullYear(), d.getMonth() - 2, 1));
  return { from, to, prevFrom, prevTo: from };
}
