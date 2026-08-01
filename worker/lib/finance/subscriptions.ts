import { toUAHMinor, type Rates } from "./finance.ts";
import type { AppDb } from "../platform/db-shim.ts";

// Детерміністичне співставлення операцій із оголошеними підписками (planned_payments).
// Мета: якщо є активна підписка (напр. «Apple» $1/міс у категорії Підписки), то нове
// списання того самого мерчанта на ту саму суму автоматично отримує КАТЕГОРІЮ підписки
// БЕЗ виклику AI — і точніше, і дешевше. Раніше підписки ніяк не впливали на категоризацію,
// тож AI вгадував (Apple $1 → помилково «Розваги»). Логіка спільна для інжесту та ре-світу.

export interface SubRow {
  id: number;
  title: string;
  period_amount: number | null; // копійки у валюті підписки
  currency_code: number;
  category_id: number | null;
  note: string | null;          // мій опис підписки для AI (§R5)
}

// Активні підписки з категорією й сумою — лише вони придатні для авто-категоризації.
async function activeSubs(db: AppDb): Promise<SubRow[]> {
  const rows = await db.prepare(
    `SELECT id, title, period_amount, currency_code, category_id, note
     FROM planned_payments
     WHERE is_active = 1 AND category_id IS NOT NULL AND period_amount IS NOT NULL AND period_amount > 0`,
  ).all<SubRow>();
  return rows.results ?? [];
}

// §SUB4 канонічне «наступне списання»: від start_date крокуємо періодом × period_count
// у майбутнє. ЄДИНЕ джерело для воркера (ендпоінти/proactive) — дзеркалиться фронтовим
// Subscriptions.nextCharge. Раніше частина ендпоінтів ігнорувала period_count, тож
// квартальна підписка помилково «спливала» щомісяця.
// §CUR-PLAN (2026-07-20): ЄДИНЕ джерело «скільки коштує план у ₴».
// Раніше кожен ендпоінт сумував `period_amount` НАПРЯМУ, ігноруючи `currency_code` —
// підписка $5 рахувалась як 5 ₴ (у «Скоро спишеться», прогнозі, календарі та в
// AI-контексті порадника). Будь-яке зведення планів у ₴ — лише через ці хелпери.
export function plannedUAH(amountMinor: number | null, code: number | null, rates: Rates): number {
  return toUAHMinor(amountMinor ?? 0, code ?? 980, rates);
}

// Сума планів у ₴. Приймає будь-які рядки з сумою+валютою (не лише SubRow).
export function sumPlannedUAH(
  plans: { period_amount: number | null; currency_code?: number | null }[],
  rates: Rates,
): number {
  return plans.reduce((s, p) => s + plannedUAH(p.period_amount, p.currency_code ?? 980, rates), 0);
}

export function nextChargeUnix(startDate: number, period: string, count = 1, now = Math.floor(Date.now() / 1000)): number {
  const n = Math.max(1, Math.round(count || 1));
  if (period === "week") { let t = startDate; while (t <= now) t += 7 * 86400 * n; return t; }
  const d = new Date(startDate * 1000);
  while (Math.floor(d.getTime() / 1000) <= now) d.setMonth(d.getMonth() + n);
  return Math.floor(d.getTime() / 1000);
}

/** Мінімум полів плану, потрібний для розкладу й місячного тягаря. */
export interface PlanLike {
  period_amount: number | null;
  currency_code?: number | null;
  period: string;
  period_count?: number | null;
  start_date: number;
  end_date?: number | null;
  kind?: string | null;
}

/** Скільки тижнів у середньому місяці — щоб тижневий план не важив як місячний. */
const WEEKS_PER_MONTH = 365.25 / 12 / 7;   // ≈ 4.348

/**
 * §SUB-MONTH (2026-08-01) — МІСЯЧНИЙ тягар плану в ₴-копійках. ЄДИНЕ джерело.
 *
 * Що це лікує: «підписок на місяць» рахувалось як `SUM(period_amount)` по всіх активних
 * планах — тобто сума СВОГО періоду в кожного. Квартальна підписка (`period='month'`,
 * `period_count=3`) важила повну суму щомісяця, тижнева — навпаки, лише свій тиждень.
 * Міграція 0011 прямо описує правильну формулу («місячний тягар = period_amount/period_count»),
 * але жоден із пʼяти сумувальників її не застосовував — і в AI-контекст їхала цифра, яку
 * користувач у себе не впізнавав.
 *
 * ⚠️ Це УСЕРЕДНЕНА величина для порівнянь («скільки підписки зʼїдають на місяць»). Для
 * питання «що спишеться до кінця місяця» вона не годиться — там потрібен розклад
 * (`chargesBetween`), бо квартальний платіж або є в цьому місяці, або його немає.
 */
export function monthlyPlannedUAH(p: PlanLike, rates: Rates, now = Math.floor(Date.now() / 1000)): number {
  const amt = plannedUAH(p.period_amount, p.currency_code ?? null, rates);
  if (amt <= 0) return 0;
  if (p.end_date != null && p.end_date <= now) return 0;   // розстрочка добігла кінця
  const n = Math.max(1, Math.round(p.period_count || 1));
  return Math.round((p.period === "week" ? amt * WEEKS_PER_MONTH : amt) / n);
}

export function sumMonthlyPlannedUAH(
  plans: PlanLike[], rates: Rates, now = Math.floor(Date.now() / 1000),
): number {
  return plans.reduce((s, p) => s + monthlyPlannedUAH(p, rates, now), 0);
}

export interface PlannedCharge<T> { plan: T; at: number; amount: number }

/**
 * Розклад списань планів у вікні [from, to] (включно), суми в ₴-копійках.
 *
 * ЄДИНЕ джерело розгортання плану в конкретні дати: той самий цикл жив трьома копіями
 * (cashflow-календар, провал ліквідності у стрічці, прогноз місяця), і кожна мала шанс
 * розійтись у дрібниці — напр. чи враховувати `end_date` розстрочки.
 * `guard` є навмисно: план із зіпсованим `period` інакше крутив би цикл вічно.
 */
export function chargesBetween<T extends PlanLike>(
  plans: T[], rates: Rates, from: number, to: number,
): PlannedCharge<T>[] {
  const out: PlannedCharge<T>[] = [];
  for (const p of plans) {
    const amount = plannedUAH(p.period_amount, p.currency_code ?? null, rates);
    if (amount <= 0) continue;
    let t = nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, from - 1);
    for (let guard = 0; guard < 400 && t <= to; guard++) {
      if (p.end_date != null && t > p.end_date) break;
      out.push({ plan: p, at: t, amount });
      t = nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, t);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// Нормалізація для нечіткого порівняння назв: латиниця+кирилиця+цифри, решта — пробіл.
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-zа-яїієґ0-9]+/gi, " ").trim();
}

// Чи назва підписки присутня в описі/мерчанті операції: або цілим підрядком
// («apple» ⊂ «apple com bill»), або будь-яким значущим словом назви (>=4 літер).
export function nameMatches(subTitle: string, hay: string): boolean {
  const t = normalize(subTitle);
  const h = normalize(hay);
  if (!t || !h) return false;
  if (h.includes(t)) return true;
  return t.split(" ").some((w) => w.length >= 4 && h.includes(w));
}

// Сума операції ≈ сумі підписки (±10%). Досить точно, щоб $1-підписка не зловила
// разову покупку $2-5 того ж мерчанта, але терпимо до FX-дрейфу для валютних підписок.
export function amountMatches(txAbsMinor: number, periodAmount: number | null): boolean {
  if (!periodAmount || periodAmount <= 0) return false;
  return Math.abs(txAbsMinor - periodAmount) <= periodAmount * 0.1;
}

// Перше значуще слово назви — для попереднього SQL-фільтра LIKE (звужує вибірку).
function firstToken(title: string): string | null {
  return normalize(title).split(" ").find((w) => w.length >= 3) ?? null;
}

// Знайти активну підписку, під яку підпадає операція (валюта + назва + сума). Без AI.
export async function matchActiveSubscription(
  db: AppDb,
  input: { merchant: string | null; description: string | null; amount: number; currency_code: number },
): Promise<{ category_id: number; title: string; planned_id: number } | null> {
  const subs = await activeSubs(db);
  if (!subs.length) return null;
  const hay = `${input.merchant ?? ""} ${input.description ?? ""}`;
  const abs = Math.abs(input.amount);
  for (const s of subs) {
    if (s.category_id == null) continue;
    if (s.currency_code !== input.currency_code) continue;
    if (!nameMatches(s.title, hay)) continue;
    if (!amountMatches(abs, s.period_amount)) continue;
    return { category_id: s.category_id, title: s.title, planned_id: s.id };
  }
  return null;
}

// Короткий опис підписок, чиї назви перегукуються з мерчантом операції — як контекст
// для AI (коли сума НЕ збіглась і детермінований матч не спрацював). Порожньо, якщо
// нічого не перегукується — тоді AI не отримує зайвих токенів (тримаємо вартість рівною).
export async function relatedSubsHint(
  db: AppDb,
  input: { merchant: string | null; description: string | null },
): Promise<string | null> {
  const subs = await activeSubs(db);
  if (!subs.length) return null;
  const hay = `${input.merchant ?? ""} ${input.description ?? ""}`;
  const hits = subs.filter((s) => nameMatches(s.title, hay));
  if (!hits.length) return null;
  const parts: string[] = [];
  for (const s of hits.slice(0, 3)) {
    const c = await db.prepare("SELECT name FROM categories WHERE id = ?").bind(s.category_id).first<{ name: string }>();
    const amt = s.period_amount != null ? (s.period_amount / 100).toFixed(2) : "?";
    const note = s.note?.trim() ? `, опис: ${s.note.trim()}` : "";
    parts.push(`«${s.title}» (~${amt}, категорія «${c?.name ?? "?"}»${note})`);
  }
  return `у користувача є схожі активні підписки: ${parts.join("; ")} — якщо ця операція є списанням такої підписки, став ту саму категорію`;
}

// §Хвіст: факт vs план по підписках. Для кожної активної підписки рахуємо ФАКТИЧНІ
// списання, прив'язані до неї (planned_id), останню суму/дату та ознаку подорожчання
// (остання сума помітно > оголошеної period_amount). Дає відповісти «скільки реально
// плачу» і «підписка подорожчала?». Без AI — просто агрегація по linked транзакціях.
export interface PlannedActual {
  id: number;              // planned_payments.id
  count: number;           // скільки фактичних списань прив'язано
  last_amount: number | null;   // остання сума (додатні копійки, у валюті операції)
  last_time: number | null;     // час останнього списання (unix)
  currency_code: number | null; // валюта останнього списання
  price_change_pct: number | null; // % відхилення останньої суми від плану (+ = подорожчало)
}

export async function plannedActuals(db: AppDb): Promise<PlannedActual[]> {
  const subs = await db.prepare(
    "SELECT id, period_amount FROM planned_payments WHERE is_active = 1",
  ).all<{ id: number; period_amount: number | null }>();
  const out: PlannedActual[] = [];
  for (const s of subs.results ?? []) {
    const agg = await db.prepare(
      `SELECT COUNT(*) AS n FROM transactions
       WHERE planned_id = ? AND amount < 0 AND is_transfer = 0`,
    ).bind(s.id).first<{ n: number }>();
    const last = await db.prepare(
      `SELECT amount, time, currency_code FROM transactions
       WHERE planned_id = ? AND amount < 0 AND is_transfer = 0
       ORDER BY time DESC LIMIT 1`,
    ).bind(s.id).first<{ amount: number; time: number; currency_code: number }>();
    const lastAbs = last ? Math.abs(last.amount) : null;
    // Подорожчання рахуємо лише коли є план і фактична сума (в тій самій валюті-порядку).
    const pct = lastAbs != null && s.period_amount && s.period_amount > 0
      ? Math.round(((lastAbs - s.period_amount) / s.period_amount) * 100)
      : null;
    out.push({
      id: s.id,
      count: agg?.n ?? 0,
      last_amount: lastAbs,
      last_time: last?.time ?? null,
      currency_code: last?.currency_code ?? null,
      price_change_pct: pct,
    });
  }
  return out;
}

// Ре-світ по наявних операціях: виправити категорію тих, що підпадають під активну
// підписку, але зараз мають іншу категорію (fix для вже неправильно розкладених, як
// Apple $1 у «Розвагах»). Запускається кнопкою в Налаштуваннях — детерміністично, без AI.
interface TxLite { id: string; merchant: string | null; raw_json: string | null; amount: number; category_id: number | null }

function descOf(rawJson: string | null): string {
  if (!rawJson) return "";
  try { return (JSON.parse(rawJson) as { description?: string }).description ?? ""; } catch { return ""; }
}

export async function applySubscriptionCategories(db: AppDb): Promise<{ fixed: number }> {
  const subs = await activeSubs(db);
  const since = Math.floor(Date.now() / 1000) - 240 * 86400;
  let fixed = 0;
  for (const s of subs) {
    if (s.category_id == null || !s.period_amount) continue;
    const token = firstToken(s.title);
    if (!token) continue;
    const rows = await db.prepare(
      `SELECT id, merchant, raw_json, amount, category_id FROM transactions
       WHERE amount < 0 AND is_transfer = 0 AND hold = 0 AND currency_code = ? AND time >= ?
         AND (LOWER(merchant) LIKE ? OR LOWER(raw_json) LIKE ?)`,
    ).bind(s.currency_code, since, `%${token}%`, `%${token}%`).all<TxLite>();
    for (const t of rows.results ?? []) {
      const hay = `${t.merchant ?? ""} ${descOf(t.raw_json)}`;
      if (!nameMatches(s.title, hay)) continue;
      if (!amountMatches(Math.abs(t.amount), s.period_amount)) continue;
      if (t.category_id === s.category_id) {
        // Категорія вже правильна — лише переконаємось, що є зв'язок із підпискою.
        await db.prepare("UPDATE transactions SET planned_id = ? WHERE id = ? AND planned_id IS NULL")
          .bind(s.id, t.id).run();
        continue;
      }
      await db.prepare("UPDATE transactions SET category_id = ?, planned_id = ?, ai_enriched = 1 WHERE id = ?")
        .bind(s.category_id, s.id, t.id).run();
      fixed++;
    }
  }
  return { fixed };
}
