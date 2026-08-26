import { toBaseMinor, type Rates } from "./money.ts";
import type { AppDb } from "../platform/db-shim.ts";
import { localParts, localWallTime } from "./time.ts";

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
  return toBaseMinor(amountMinor ?? 0, code ?? 980, rates);
}

// Сума планів у ₴. Приймає будь-які рядки з сумою+валютою (не лише SubRow).
export function sumPlannedUAH(
  plans: { period_amount: number | null; currency_code?: number | null }[],
  rates: Rates,
): number {
  return plans.reduce((s, p) => s + plannedUAH(p.period_amount, p.currency_code ?? 980, rates), 0);
}

function daysInMonth(y: number, mIndex: number): number {
  return new Date(Date.UTC(y, mIndex + 1, 0)).getUTCDate();
}

export function nextChargeUnix(startDate: number, period: string, count = 1, now = Math.floor(Date.now() / 1000)): number {
  const n = Math.max(1, Math.round(count || 1));
  if (period === "week") { let t = startDate; while (t <= now) t += 7 * 86400 * n; return t; }

  // ⚠️ Every charge is counted from the START, not from the previous one (2026-08-27). The old
  // implementation stepped a `Date` with `setMonth(+1)`, and JavaScript resolves 31 February by
  // ROLLING OVER: a plan starting on the 31st went 31 Jan → 3 Mar → 3 Apr, skipping February
  // outright and then charging on the 3rd for the rest of its life. A subscription whose date
  // quietly moves is worse than one that is late — it lands in a different budget month, and the
  // charge that "disappeared" is the one nobody goes looking for.
  // ⚠️ The anchor is the KYIV day (§APP_TZ): a charge at 01:00 Kyiv on the 20th is the 19th in UTC,
  // and reading it as the 19th would move every schedule a day earlier than the person's calendar.
  const p = localParts(startDate);
  // Start the scan near `now` rather than at the plan's birth: a plan from 2019 would otherwise
  // cost ~80 timezone resolutions per call, and `chargesBetween` calls this in a loop.
  const q = localParts(Math.max(now, startDate));
  let k = Math.max(0, Math.floor((((q.y - p.y) * 12 + (q.m - p.m)) - n) / n) * n);
  for (let guard = 0; guard < 600; guard++, k += n) {
    const mi = (p.m - 1) + k;                       // months since January of the start's year
    const y = p.y + Math.floor(mi / 12);
    const m0 = ((mi % 12) + 12) % 12;               // 0-based, for `daysInMonth`
    // Clamp, never roll over: the 31st of a 30-day month is that month's LAST day, which is what
    // every biller in the world does.
    // `localWallTime` rather than midnight + seconds: on the day the clocks change there are 23 or
    // 25 hours, and adding a time-of-day to midnight moves the charge by one (§APP_TZ).
    const t = localWallTime(y, m0 + 1, Math.min(p.d, daysInMonth(y, m0)), p.hh, p.mm, p.ss);
    if (t > now) return t;
  }
  return startDate;
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

/**
 * §SUB-ALIAS (2026-08-27) — a subscription is known by more than its title.
 *
 * A brand bills under a name the person does not use: the plan says «Twitter», the statement says
 * «X Corp.», and the title alone matches nothing — so the charge never gets `planned_id`, the
 * category is guessed by AI, and `plannedActuals` reports zero charges. That last one is visible:
 * the feed announced «YouTube Premium — списань не видно» for a subscription being paid every
 * month, which teaches the reader to distrust the whole card.
 *
 * The extra names come from the plan's own `note` — the field the user already fills in to tell
 * the AI what this is. Words of four letters or more, minus the ones every subscription note
 * contains and which therefore identify none of them.
 *
 * ⚠️ These are only ever a NAME test. The amount (±10%) and the currency still have to agree, so a
 * loose alias cannot pull in an unrelated purchase from the same merchant — that gate is what makes
 * reading free prose safe here.
 */
const NOTE_STOPWORDS = new Set([
  "підписка", "підписки", "підписку", "оплата", "оплату", "платіж", "щомісяця", "щомісячно",
  "місяць", "місяця", "сервіс", "тариф", "акаунт", "передплата", "списання", "кожного",
  "subscription", "monthly", "payment", "service", "plan", "account", "yearly", "annual",
]);

export function planNeedles(sub: { title: string; note?: string | null }): string[] {
  const out = [sub.title];
  for (const w of normalize(sub.note ?? "").split(" ")) {
    if (w.length >= 4 && !NOTE_STOPWORDS.has(w)) out.push(w);
  }
  return [...new Set(out)];
}

/** Does ANY of a plan's names appear in the text? */
export function planMatches(sub: { title: string; note?: string | null }, hay: string): boolean {
  return planNeedles(sub).some((n) => nameMatches(n, hay));
}

/**
 * Everything the app knows about an operation as ONE searchable string.
 *
 * ⚠️ `ai_note` is in here on purpose: it is where the model writes down what the user explained
 * about a charge («X (твітер) підписка»), and leaving it out means the app forgets an answer it
 * was given. Same reasoning as `searchHaystack` in `repo/planning.ts` — one text, matched the same
 * way wherever it is matched.
 */
export function txHaystack(t: {
  merchant?: string | null; description?: string | null; ai_note?: string | null; comment?: string | null;
}): string {
  return `${t.merchant ?? ""} ${t.description ?? ""} ${t.ai_note ?? ""} ${t.comment ?? ""}`;
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
  input: { merchant: string | null; description: string | null; amount: number; currency_code: number;
           ai_note?: string | null; comment?: string | null },
): Promise<{ category_id: number; title: string; planned_id: number } | null> {
  const subs = await activeSubs(db);
  if (!subs.length) return null;
  const hay = txHaystack(input);
  const abs = Math.abs(input.amount);
  for (const s of subs) {
    if (s.category_id == null) continue;
    if (s.currency_code !== input.currency_code) continue;
    if (!planMatches(s, hay)) continue;
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
  input: { merchant: string | null; description: string | null; ai_note?: string | null; comment?: string | null },
): Promise<string | null> {
  const subs = await activeSubs(db);
  if (!subs.length) return null;
  const hay = txHaystack(input);
  const hits = subs.filter((s) => planMatches(s, hay));
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
  // ONE grouped query instead of two per plan (2026-08-27). With a dozen subscriptions that was
  // 24 round trips to answer a question about a single table — and this runs on every open of the
  // Subscriptions page and inside `dead_sub` drafting.
  const agg = await db.prepare(
    `SELECT t.planned_id AS id, COUNT(*) AS n,
            MAX(t.time) AS last_time,
            (SELECT ABS(x.amount) FROM transactions x
             WHERE x.planned_id = t.planned_id AND x.amount < 0 AND x.is_transfer = 0
             ORDER BY x.time DESC LIMIT 1) AS last_amount,
            (SELECT x.currency_code FROM transactions x
             WHERE x.planned_id = t.planned_id AND x.amount < 0 AND x.is_transfer = 0
             ORDER BY x.time DESC LIMIT 1) AS currency_code
     FROM transactions t
     WHERE t.planned_id IS NOT NULL AND t.amount < 0 AND t.is_transfer = 0
     GROUP BY t.planned_id`,
  ).all<{ id: number; n: number; last_time: number; last_amount: number; currency_code: number }>();
  const byId = new Map((agg.results ?? []).map((r) => [r.id, r]));

  const out: PlannedActual[] = [];
  for (const s of subs.results ?? []) {
    const a = byId.get(s.id);
    const last = a ? { amount: a.last_amount, time: a.last_time, currency_code: a.currency_code } : null;
    const lastAbs = last ? Math.abs(last.amount) : null;
    // Подорожчання рахуємо лише коли є план і фактична сума (в тій самій валюті-порядку).
    const pct = lastAbs != null && s.period_amount && s.period_amount > 0
      ? Math.round(((lastAbs - s.period_amount) / s.period_amount) * 100)
      : null;
    out.push({
      id: s.id,
      count: a?.n ?? 0,
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
interface TxLite {
  id: string; merchant: string | null; raw_json: string | null; ai_note: string | null;
  comment: string | null; amount: number; category_id: number | null;
}

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
    // §SUB-ALIAS: every name the plan is known by, not just its title — and the pre-filter has to
    // widen with it, or the alias would be tested against rows SQL already threw away.
    const tokens = [...new Set(planNeedles(s).map(firstToken).filter((x): x is string => !!x))];
    if (!tokens.length) continue;
    const like = tokens.map(() => "(LOWER(merchant) LIKE ? OR LOWER(raw_json) LIKE ? OR LOWER(ai_note) LIKE ? OR LOWER(comment) LIKE ?)");
    const binds = tokens.flatMap((tk) => [`%${tk}%`, `%${tk}%`, `%${tk}%`, `%${tk}%`]);
    const rows = await db.prepare(
      `SELECT id, merchant, raw_json, ai_note, comment, amount, category_id FROM transactions
       WHERE amount < 0 AND is_transfer = 0 AND hold = 0 AND currency_code = ? AND time >= ?
         AND (${like.join(" OR ")})`,
    ).bind(s.currency_code, since, ...binds).all<TxLite>();
    for (const t of rows.results ?? []) {
      const hay = txHaystack({ merchant: t.merchant, description: descOf(t.raw_json), ai_note: t.ai_note, comment: t.comment });
      if (!planMatches(s, hay)) continue;
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
