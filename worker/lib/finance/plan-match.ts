/**
 * Матчинг «яка це операція» — і привʼязка плану до його списань.
 *
 * Виділено зі `subscriptions.ts` 2026-08-27 під лінт C3, і шов справжній — той самий, що
 * `levels.ts` зі `stats.ts` у той же день. `subscriptions.ts` відповідає на питання про РОЗКЛАД
 * і ТЯГАР плану (коли наступне списання, скільки це на місяць) і після цього виносу не має
 * доступу до бази взагалі. Тут — інше питання: ЯКА транзакція є цим планом. Воно єдине, що
 * ходить у БД, і саме воно росло весь час (§SUB-ALIAS, потім §PLAN-LINK).
 *
 * Усе реекспортується зі `subscriptions.ts`, тож жоден список імпортів не змінився і визначення
 * лишається рівно одне.
 */
import type { AppDb } from "../platform/db-shim.ts";
import { fitsNextCycle, repriceAmountPlausible, declaredIntervalDays } from "./plan-state.ts";

export interface SubRow {
  id: number;
  title: string;
  period_amount: number | null; // копійки у валюті підписки
  currency_code: number;
  category_id: number | null;
  note: string | null;          // мій опис підписки для AI (§R5)
  // The schedule, for §PLAN-REPRICE's cycle window. Optional so a caller that only needs the
  // name/amount test keeps constructing a SubRow the way it did.
  period?: string;
  period_count?: number | null;
}

/**
 * Активні плани з сумою — придатні для звʼязування операцій.
 *
 * ⚠️ **`category_id` більше НЕ обовʼязковий** (§PLAN-LINK, 2026-08-27). Він тут стояв тому, що
 * привʼязка (`planned_id`) і категоризація були ОДНІЄЮ дією — тож план без категорії не міг ні
 * того, ні того. А форма ручного додавання підписки категорії не питає взагалі: тобто кожен план,
 * доданий руками, не збігався з жодною операцією НІКОЛИ, навіть на інжесті. Це два різні питання
 * («яка це операція» і «куди її віднести»), і план відповідає на перше, навіть коли мовчить про друге.
 */
async function activeSubs(db: AppDb): Promise<SubRow[]> {
  const rows = await db.prepare(
    `SELECT id, title, period_amount, currency_code, category_id, note, period, period_count
     FROM planned_payments
     WHERE is_active = 1 AND period_amount IS NOT NULL AND period_amount > 0`,
  ).all<SubRow>();
  return rows.results ?? [];
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


/**
 * Знайти активну підписку, під яку підпадає операція (валюта + назва + сума). Без AI.
 *
 * ⚠️ `category_id` може бути `null` — план без категорії все одно ВПІЗНАЄ своє списання (§PLAN-LINK).
 * Викликач мусить це розрізняти: привʼязати `planned_id` можна завжди, а поставити категорію — ні.
 */
export async function matchActiveSubscription(
  db: AppDb,
  input: { merchant: string | null; description: string | null; amount: number; currency_code: number;
           ai_note?: string | null; comment?: string | null; time?: number; id?: string },
): Promise<{ category_id: number | null; title: string; planned_id: number; repriced?: boolean } | null> {
  const subs = await activeSubs(db);
  if (!subs.length) return null;
  const hay = txHaystack(input);
  const abs = Math.abs(input.amount);
  const named = subs.filter((s) => s.currency_code === input.currency_code && planMatches(s, hay));
  for (const s of named) {
    if (!amountMatches(abs, s.period_amount)) continue;
    return { category_id: s.category_id, title: s.title, planned_id: s.id };
  }
  // §PLAN-REPRICE — the name agrees and the amount does not. Only with the operation's time can
  // the cycle stand in for the amount gate; without it (a caller that has no time) the answer
  // stays «no match», which is what it was before this tier existed.
  if (input.time == null) return null;
  for (const s of named) {
    if (await repriceFits(db, s, input.time, abs, input.id ?? null)) {
      return { category_id: s.category_id, title: s.title, planned_id: s.id, repriced: true };
    }
  }
  return null;
}

/**
 * §PLAN-REPRICE (2026-09-25) — a charge whose NAME is the plan's but whose AMOUNT is not.
 *
 * The case, verbatim from the owner's ledger: YouTube had been 100 ₴ for months, then 179 ₴ landed
 * on the usual day. `amountMatches` (±10%) refused it, so the charge was never linked, the price
 * rise was never noticed (`draftPriceUps` reads LINKED charges only), and the subscription card
 * kept promising next month's date for a plan whose current charge it had missed.
 *
 * The amount gate cannot simply be widened: it is what keeps a loose alias from pulling in a
 * one-off purchase from the same brand. So for this tier it is REPLACED by a set of conditions that
 * together are at least as strict about identity:
 *   · the plan has an established series — at least one earlier linked charge to anchor on
 *     (a brand-new plan may not claim a stranger);
 *   · the charge lands one, two or three declared cycles after that anchor (`fitsNextCycle`) —
 *     a mid-cycle purchase does not;
 *   · the price moved within a plausible factor of the anchor (`repriceAmountPlausible`, ×3) —
 *     a 10 000 ₴ purchase is never a repriced 100 ₴ plan;
 *   · the cycle is not already settled — no linked charge in the half-cycle after it either,
 *     so a healing pass over history cannot give one cycle two charges.
 *
 * ⚠️ The link is a fact («this charge is that plan»); the plan's `period_amount` is NOT touched.
 * The card then shows the declared price against the real one (`price_change_pct`, §PRICE-STEPS)
 * and a person decides. A near-match never silently rewrites money.
 */
async function repriceFits(
  db: AppDb, s: SubRow, t: number, abs: number, selfId: string | null,
): Promise<boolean> {
  if (!s.period) return false;
  const count = s.period_count ?? 1;
  const anchor = await db.prepare(
    `SELECT time, ABS(amount) AS amount FROM transactions
     WHERE planned_id = ? AND amount < 0 AND is_transfer = 0 AND time < ?
     ORDER BY time DESC LIMIT 1`,
  ).bind(s.id, t).first<{ time: number; amount: number }>();
  if (!anchor) return false;
  if (!fitsNextCycle(anchor.time, t, s.period, count)) return false;
  if (!repriceAmountPlausible(abs, anchor.amount)) return false;
  const halfCycle = Math.floor(declaredIntervalDays(s.period, count) * 86400 / 2);
  const later = await db.prepare(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE planned_id = ? AND amount < 0 AND is_transfer = 0 AND time >= ? AND time < ? AND id != ?`,
  ).bind(s.id, t, t + halfCycle, selfId ?? "").first<{ n: number }>();
  return (later?.n ?? 0) === 0;
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
    // A plan may carry no category (§PLAN-LINK) — then there is nothing to nudge the model
    // towards, and naming a category it does not have would be worse than saying nothing.
    const c = s.category_id == null ? null
      : await db.prepare("SELECT name FROM categories WHERE id = ?").bind(s.category_id).first<{ name: string }>();
    const amt = s.period_amount != null ? (s.period_amount / 100).toFixed(2) : "?";
    const note = s.note?.trim() ? `, опис: ${s.note.trim()}` : "";
    const cat = c?.name ? `, категорія «${c.name}»` : "";
    parts.push(`«${s.title}» (~${amt}${cat}${note})`);
  }
  return `у користувача є схожі активні підписки: ${parts.join("; ")} — якщо ця операція є списанням такої підписки, став ту саму категорію`;
}

// Ре-світ по наявних операціях: виправити категорію тих, що підпадають під активну
// підписку, але зараз мають іншу категорію (fix для вже неправильно розкладених, як
// Apple $1 у «Розвагах»). Запускається кнопкою в Налаштуваннях — детерміністично, без AI.
interface TxLite {
  id: string; merchant: string | null; raw_json: string | null; ai_note: string | null;
  comment: string | null; amount: number; category_id: number | null; planned_id: number | null;
}

function descOf(rawJson: string | null): string {
  if (!rawJson) return "";
  try { return (JSON.parse(rawJson) as { description?: string }).description ?? ""; } catch { return ""; }
}

/** Скільки років історії переглядаємо, звʼязуючи план із його списаннями. */
const LINK_WINDOW_DAYS = 730;

export interface PlanLinkResult { linked: number; recategorised: number }

/**
 * §PLAN-LINK (2026-08-27) — ОДИН план знаходить свої списання в уже наявній історії.
 *
 * **Це головна вада, через яку вся фіча читалась як зламана.** `transactions.planned_id`
 * проставлявся рівно у двох місцях: на ІНЖЕСТІ нової операції і всередині
 * `applySubscriptionCategories` — кнопки в Налаштуваннях, про яку ніхто не знає. `POST /planned`
 * створював рядок і не робив більше нічого. Тобто щойно доданий план мав НУЛЬ списань — і
 * сторінка підписки казала «списань не видно», і стрічка казала те саме, і «чи подорожчала»
 * не мало відповіді, — при тому що всі дванадцять списань лежали в тій самій таблиці поруч.
 *
 * ⚠️ **Привʼязка й категоризація — ДВІ різні дії, і вони розчеплені.** `planned_id` ставиться
 * завжди (це факт «ця операція є цим планом»); категорія — лише коли план її має і лише коли
 * операція ще не має СВОЄЇ. Доти вони були злиті, тож план без категорії не робив нічого.
 * ⚠️ **Чужа категорія НЕ перетирається.** Збережена категорія — це рішення (MCC банку, навчений
 * alias, AI-enrich або сама людина), а план каже лише «це те саме списання». Те саме правило, що
 * §RULES-UI apply і §SIMILAR: застосунок не сперечається мовчки з уже зробленою роботою.
 * ⚠️ Вікно — два роки, а не 240 днів: план заводять САМЕ тоді, коли підписка вже давно платиться,
 * і півроку історії — це рівно та частина відповіді, якої бракує.
 */
export async function linkPlanHistory(db: AppDb, sub: SubRow): Promise<PlanLinkResult> {
  const out: PlanLinkResult = { linked: 0, recategorised: 0 };
  if (!sub.period_amount) return out;
  const since = Math.floor(Date.now() / 1000) - LINK_WINDOW_DAYS * 86400;
  // The pre-filter is the AMOUNT (the same ±10% `amountMatches` applies), not the name. It used to
  // be `LOWER(merchant) LIKE '%київстар%'`, and SQLite folds case for ASCII only: a Cyrillic plan
  // title never matched a capitalised Cyrillic merchant, so «Київстар» could not find its own
  // history (2026-09-21). The name — every alias of it (§SUB-ALIAS) — is tested below in JS, which
  // lower-cases Cyrillic correctly; the amount window keeps the scan to a handful of rows.
  const lo = Math.floor(sub.period_amount * 0.9), hi = Math.ceil(sub.period_amount * 1.1);
  // ⚠️ No `hold = 0` (dropped 2026-08-27). Holds are COUNTED everywhere else (canon, `stats.ts`,
  // and `merchantMatches` in `repo/planning.ts` for this very reason): mono overwrites the SAME id
  // on settlement, so there is no double link — while the filter cut the freshest week out, which
  // on a plan created today is the charge the person is looking at.
  const rows = await db.prepare(
    `SELECT id, merchant, raw_json, ai_note, comment, amount, category_id, planned_id FROM transactions
     WHERE amount < 0 AND is_transfer = 0 AND currency_code = ? AND time >= ?
       AND -amount BETWEEN ? AND ?`,
  ).bind(sub.currency_code, since, lo, hi).all<TxLite>();

  for (const t of rows.results ?? []) {
    const hay = txHaystack({ merchant: t.merchant, description: descOf(t.raw_json), ai_note: t.ai_note, comment: t.comment });
    if (!planMatches(sub, hay)) continue;
    if (!amountMatches(Math.abs(t.amount), sub.period_amount)) continue;

    // The link itself. Never re-pointed: a row already claimed by ANOTHER plan was matched by that
    // plan's own name and amount, and silently moving it would make two screens disagree about
    // which subscription a charge belongs to.
    if (t.planned_id == null) {
      await db.prepare("UPDATE transactions SET planned_id = ? WHERE id = ? AND planned_id IS NULL")
        .bind(sub.id, t.id).run();
      out.linked++;
    }
    // The category, only into a genuine GAP.
    if (sub.category_id != null && t.category_id == null) {
      await db.prepare("UPDATE transactions SET category_id = ?, ai_enriched = 1 WHERE id = ? AND category_id IS NULL")
        .bind(sub.category_id, t.id).run();
      out.recategorised++;
    }
  }

  // §PLAN-REPRICE, the healing half: without it a price change stays invisible to history, and
  // `paidOnSecondLook` (the feed's «look once more before saying it was missed») looks through the
  // same ±10% window and misses the very charge it is looking for.
  // Oldest first, so each repriced charge becomes the anchor for the next one — three months at
  // 179 ₴ after nine at 100 ₴ link as a chain, not only the first.
  // The SQL window is ×3 either way (`REPRICE_MAX_FACTOR`); `repriceFits` decides against the
  // ANCHOR's amount, which is the price actually being paid, not the declared one.
  if (sub.period) {
    const wide = await db.prepare(
      `SELECT id, merchant, raw_json, ai_note, comment, amount, category_id, planned_id, time FROM transactions
       WHERE amount < 0 AND is_transfer = 0 AND currency_code = ? AND time >= ? AND planned_id IS NULL
         AND -amount BETWEEN ? AND ? AND NOT (-amount BETWEEN ? AND ?)
       ORDER BY time ASC`,
    ).bind(sub.currency_code, since, Math.floor(sub.period_amount / 3), Math.ceil(sub.period_amount * 3), lo, hi)
      .all<TxLite & { time: number }>();
    for (const t of wide.results ?? []) {
      const hay = txHaystack({ merchant: t.merchant, description: descOf(t.raw_json), ai_note: t.ai_note, comment: t.comment });
      if (!planMatches(sub, hay)) continue;
      if (!(await repriceFits(db, sub, t.time, Math.abs(t.amount), t.id))) continue;
      await db.prepare("UPDATE transactions SET planned_id = ? WHERE id = ? AND planned_id IS NULL")
        .bind(sub.id, t.id).run();
      out.linked++;
      if (sub.category_id != null && t.category_id == null) {
        await db.prepare("UPDATE transactions SET category_id = ?, ai_enriched = 1 WHERE id = ? AND category_id IS NULL")
          .bind(sub.category_id, t.id).run();
        out.recategorised++;
      }
    }
  }
  return out;
}

/**
 * Ре-світ по ВСІХ активних планах (кнопка в Налаштуваннях).
 *
 * ⚠️ Тепер це просто цикл над `linkPlanHistory` — раніше тіло жило тут, і саме тому привʼязка
 * була доступна лише через цю кнопку. `fixed` лишається сумою обох дій: це число для людини
 * («стільки операцій зачеплено»), а не величина, з якої щось рахують.
 */
export async function applySubscriptionCategories(db: AppDb): Promise<{ fixed: number }> {
  const subs = await activeSubs(db);
  let fixed = 0;
  for (const s of subs) {
    const r = await linkPlanHistory(db, s);
    fixed += r.linked + r.recategorised;
  }
  return { fixed };
}

/** Той самий прохід, але для ОДНОГО плану за його id — для роутів створення/редагування. */
export async function linkPlanHistoryById(db: AppDb, id: number): Promise<PlanLinkResult> {
  const sub = await db.prepare(
    "SELECT id, title, period_amount, currency_code, category_id, note, period, period_count FROM planned_payments WHERE id = ? AND is_active = 1",
  ).bind(id).first<SubRow>();
  return sub ? await linkPlanHistory(db, sub) : { linked: 0, recategorised: 0 };
}
