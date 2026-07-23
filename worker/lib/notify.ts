// Центр сповіщень (ROADMAP §Черга 2, v1 = in-app only). ЄДИНЕ джерело подій стрічки:
// генерація + CRUD. Викликається добовим кроном (0 6 * * * UTC ≈ 08:00 Київ) і вручну.
//
// 🔒 Правила, які тут тримаємо:
//  • Усі цифри — через канон `stats.ts` (STATS_JOINS + SPEND_WHERE + amountSum + рівні
//    категорій). Не дублюємо SQL-фільтри — інакше стрічка скаже одне, а Статистика інше.
//  • Суми планів — лише `plannedUAH` (§CUR-PLAN): підписка $5 ≠ 5 ₴.
//  • `dedup_key` обовʼязковий, вставка через INSERT OR IGNORE — крон ганяється щодня
//    й не має плодити ту саму подію. Ключ містить «період актуальності» (місяць/дату),
//    щоб подія все ж повторилась наступного разу, коли це справді нова новина.
//  • Ліміт на прохід (`MAX_PER_RUN`) — стрічка не має перетворюватись на спам.
import type { Env } from "../env.ts";
import { getRates } from "./finance.ts";
import { nextChargeUnix, plannedUAH, plannedActuals } from "./subscriptions.ts";
import {
  STATS_JOINS, SPEND_WHERE, EFF_CAT_ID, EFF_CAT_NAME, amountSum, valueMode,
  categoryMonthlyLevels, projectSpend, isRecurringExpr, defaultRefFrom,
} from "./stats.ts";
import { getState, setState } from "./repo.ts";

export type NotifKind =
  | "report" | "deadline" | "anomaly" | "budget" | "price_up" | "liquidity"
  | "big_tx" | "duplicate" | "health_drop" | "goal_risk" | "dead_sub" | "win" | "todo" | "ai";
export type Severity = "info" | "warn" | "urgent";

export const NOTIF_KINDS: NotifKind[] = [
  "report", "deadline", "anomaly", "budget", "price_up", "liquidity",
  "big_tx", "duplicate", "health_drop", "goal_risk", "dead_sub", "win", "todo", "ai",
];

export interface NotifRow {
  id: number;
  kind: NotifKind;
  title: string;
  body: string | null;
  severity: Severity;
  entity_type: string | null;
  entity_id: string | null;
  created_at: number;
  read_at: number | null;
}

interface Draft {
  kind: NotifKind;
  title: string;
  body?: string | null;
  severity?: Severity;
  entity_type?: string | null;
  entity_id?: string | null;
  dedup_key: string;
}

const MAX_PER_RUN = 15;
const PREFS_KEY = "notify_prefs";
/** Прочитані події старші за це — прибирає крон. Непрочитані НЕ чіпаємо (їх ще не бачили). */
const RETENTION_DAYS = 90;

export type NotifPrefs = Record<NotifKind, boolean>;
const DEFAULT_PREFS: NotifPrefs = {
  report: true, deadline: true, anomaly: true, budget: true, price_up: true, liquidity: true,
  big_tx: true, duplicate: true, health_drop: true, goal_risk: true, dead_sub: true,
  win: true, todo: true, ai: true,
};

export async function getPrefs(env: Env): Promise<NotifPrefs> {
  const raw = await getState(env.DB, PREFS_KEY);
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const parsed = JSON.parse(raw) as Partial<NotifPrefs>;
    const out = { ...DEFAULT_PREFS };
    for (const k of NOTIF_KINDS) if (typeof parsed[k] === "boolean") out[k] = parsed[k];
    return out;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function setPrefs(env: Env, patch: Partial<NotifPrefs>): Promise<NotifPrefs> {
  const cur = await getPrefs(env);
  for (const k of NOTIF_KINDS) if (typeof patch[k] === "boolean") cur[k] = patch[k]!;
  await setState(env.DB, PREFS_KEY, JSON.stringify(cur));
  return cur;
}

// ---- читання стрічки ---------------------------------------------------------

export async function listNotifications(
  env: Env, opts: { limit?: number; kind?: string | null; unreadOnly?: boolean } = {},
): Promise<{ items: NotifRow[]; unread: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (opts.kind && NOTIF_KINDS.includes(opts.kind as NotifKind)) { where.push("kind = ?"); binds.push(opts.kind); }
  if (opts.unreadOnly) where.push("read_at IS NULL");
  const sql = `SELECT id, kind, title, body, severity, entity_type, entity_id, created_at, read_at
               FROM notifications ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  const rows = await env.DB.prepare(sql).bind(...binds, limit).all<NotifRow>();
  const unread = await unreadCount(env);
  return { items: rows.results ?? [], unread };
}

export async function unreadCount(env: Env): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL")
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function markRead(env: Env, ids: number[]): Promise<void> {
  if (!ids.length) return;
  const now = Math.floor(Date.now() / 1000);
  const holes = ids.map(() => "?").join(",");
  await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND id IN (${holes})`)
    .bind(now, ...ids).run();
}

export async function markAllRead(env: Env): Promise<void> {
  await env.DB.prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL")
    .bind(Math.floor(Date.now() / 1000)).run();
}

export async function clearNotifications(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM notifications").run();
}

// ---- генерація ---------------------------------------------------------------

const uah = (minor: number) => `${Math.round(minor / 100).toLocaleString("uk-UA")} ₴`;
const isoDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const dayMonth = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString("uk-UA", { day: "numeric", month: "long" });

/**
 * Свіжі AI-репорти, про які ще не сповіщали. Ідемпотентність — по `report:<id>`.
 *
 * ⚠️ Вікно СВІДОМО вузьке (3 дні, ≤2 шт). З 14-денним вікном перший же прогін вивалював
 * у стрічку всю історію репортів одним стосом — 4 «Готовий тижневий репорт» поспіль
 * (спіймано на реальному запуску). Сповіщення — про НОВЕ, а не про архів: старі репорти
 * і так лежать на `/reports`.
 */
async function draftReports(env: Env, now: number): Promise<Draft[]> {
  const rows = await env.DB.prepare(
    `SELECT id, period_type, period_from, period_to, summary FROM ai_reports
     WHERE created_at >= ? ORDER BY created_at DESC LIMIT 2`,
  ).bind(now - 3 * 86400)
    .all<{ id: number; period_type: string; period_from: number; period_to: number; summary: string | null }>();
  return (rows.results ?? []).map((r) => ({
    kind: "report" as const,
    // Період у заголовку: чотири однакові «Готовий тижневий репорт» у стрічці не розрізнити.
    title: `${r.period_type === "month" ? "Місячний" : "Тижневий"} репорт · ${dayMonth(r.period_from)} – ${dayMonth(r.period_to)}`,
    // У стрічці — короткий витяг, не сам репорт: клік веде на /reports/:id.
    body: (r.summary ?? "").slice(0, 220) || null,
    severity: "info" as const,
    entity_type: "report", entity_id: String(r.id),
    dedup_key: `report:${r.id}`,
  }));
}

/** Списання планів/підписок у горизонті 3 днів. §CUR-PLAN: сума зводиться plannedUAH. */
async function draftDeadlines(env: Env, now: number): Promise<Draft[]> {
  const rates = await getRates(env.DB);
  const rows = await env.DB.prepare(
    `SELECT id, title, kind, period_amount, currency_code, period, period_count, start_date, end_date
     FROM planned_payments WHERE is_active = 1`,
  ).all<{
    id: number; title: string; kind: string; period_amount: number | null; currency_code: number | null;
    period: string; period_count: number | null; start_date: number; end_date: number | null;
  }>();

  const out: Draft[] = [];
  for (const p of rows.results ?? []) {
    const amt = p.period_amount ?? 0;
    if (amt <= 0) continue;
    const at = nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, now);
    if (p.end_date != null && at > p.end_date) continue;   // розстрочка добігла кінця
    const days = Math.round((at - now) / 86400);
    if (days > 3) continue;
    const amountUAH = plannedUAH(amt, p.currency_code, rates);
    const when = days <= 0 ? "сьогодні" : days === 1 ? "завтра" : `через ${days} дн`;
    out.push({
      kind: "deadline",
      title: `${p.title} — списання ${when}`,
      body: `${uah(amountUAH)} · ${dayMonth(at)}`,
      severity: days <= 2 ? "warn" : "info",
      entity_type: "planned", entity_id: String(p.id),
      // Ключ по ДАТІ списання: наступного разу подія має зʼявитись знову.
      dedup_key: `deadline:${p.id}:${isoDay(at)}`,
    });
  }

  // Платіж по кредитці (§Кредитка): рахунки з payment_day + використаним кредитом. Нагадуємо
  // за ≤3 дні. Це той самий `deadline` (та сама пресета/фільтр), лише entity=account.
  let cards: { id: string; title: string | null; type: string | null; balance: number; credit_limit: number; currency_code: number; payment_day: number | null; min_payment: number | null }[] = [];
  try {
    const r = await env.DB.prepare(
      `SELECT id, title, type, balance, credit_limit, currency_code, payment_day, min_payment
       FROM accounts WHERE is_active = 1 AND credit_limit > 0 AND payment_day IS NOT NULL`,
    ).all<typeof cards[number]>();
    cards = r.results ?? [];
  } catch { /* колонки кредитки можуть ще не бути на remote (0027) — гілка мовчки пропускається */ }
  for (const a of cards) {
    const used = (a.credit_limit ?? 0) - (a.balance ?? 0); // борг = ліміт − доступний баланс
    if (used <= 0) continue;                                // нема боргу — нема про що нагадувати
    const at = nextMonthlyDay(a.payment_day!, now);
    const days = Math.round((at - now) / 86400);
    if (days > 3) continue;
    const amt = a.min_payment && a.min_payment > 0 ? a.min_payment : used;
    const amtUAH = plannedUAH(amt, a.currency_code, rates);
    const label = a.min_payment && a.min_payment > 0 ? "мін. платіж" : "борг";
    const when = days <= 0 ? "сьогодні" : days === 1 ? "завтра" : `через ${days} дн`;
    out.push({
      kind: "deadline",
      title: `${a.title ?? "Кредитка"} — платіж ${when}`,
      body: `${label} ${uah(amtUAH)} · до ${dayMonth(at)}`,
      severity: "warn",  // пропущений платіж по кредитці дорогий → завжди у TG-пуш
      entity_type: "account", entity_id: a.id,
      dedup_key: `deadline:credit:${a.id}:${isoDay(at).slice(0, 7)}`,
    });
  }
  return out;
}

// Наступна дата, коли настане задане число місяця (payment_day), ≥ now. UTC-полудень, щоб
// уникнути крайових зсувів; якщо в місяці менше днів — беремо останній день місяця.
function nextMonthlyDay(day: number, now: number): number {
  const d = new Date(now * 1000);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  const mk = (yy: number, mm: number) => {
    const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
    return Math.floor(Date.UTC(yy, mm, Math.min(day, last), 12, 0, 0) / 1000);
  };
  let at = mk(y, m);
  if (at < now) { m++; if (m > 11) { m = 0; y++; } at = mk(y, m); }
  return at;
}

// Спільна база для `anomaly` і `win`: витрати поточного місяця по категоріях (канон) +
// канонічні місячні рівні. Один запит на дві гілки — не сканим транзакції двічі.
interface MonthPace {
  monthKey: string; elapsedFrac: number;
  rows: { id: number; name: string; spent: number; n: number; usual: number }[];
}
async function monthPace(env: Env, now: number): Promise<MonthPace> {
  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null);
  const d = new Date(now * 1000);
  const monthStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
  const nextMonthStart = Math.floor(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() / 1000);
  const elapsedFrac = Math.min(1, Math.max(0.02, (now - monthStart) / (nextMonthStart - monthStart)));

  const levels = await categoryMonthlyLevels(env, mult, { now });
  const cur = await env.DB.prepare(
    `SELECT ${EFF_CAT_ID} AS id, ${EFF_CAT_NAME} AS name, ${amountSum(mult)} AS spent,
            COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
     GROUP BY ${EFF_CAT_ID}`,
  ).bind(monthStart, now).all<{ id: number | null; name: string | null; spent: number; n: number }>();

  const rows = (cur.results ?? [])
    .filter((r): r is { id: number; name: string | null; spent: number; n: number } => r.id != null)
    .map((r) => ({ id: r.id, name: r.name ?? "без категорії", spent: r.spent, n: r.n, usual: levels.get(r.id)?.level ?? 0 }));
  return { monthKey: new Date(now * 1000).toISOString().slice(0, 7), elapsedFrac, rows };
}

/** Аномалія темпу категорії — той самий канон, що й «Радар аномалій» (/analytics/patterns). */
function draftAnomalies(pace: MonthPace): Draft[] {
  // Рано в місяці темп ще не сигнал — не шумимо, поки не минула чверть.
  if (pace.elapsedFrac < 0.25) return [];
  const MIN_DELTA = 20000; // 200 ₴ — нижче не шумимо (як у Радарі)
  // ⚠️ Поріг на ЗВИЧНИЙ рівень. Коли `usual` мізерний, відсоток вибухає й перестає щось
  // означати: «Підписки — 1 613 ₴ проти звичних 99 ₴ (1629%)» — це не «розганяється темп»,
  // а те, що база порівняння порожня (спіймано на реальному запуску).
  const MIN_USUAL = 50000; // 500 ₴/міс
  const out: Draft[] = [];
  for (const r of pace.rows) {
    if (r.spent <= 0 || r.usual < MIN_USUAL) continue;
    // Лумп (1 операція) не екстраполюємо — це вже сталося, а не «розганяється темп».
    if (r.n <= 1) continue;
    const projected = projectSpend(r.spent, r.usual, pace.elapsedFrac, false);
    if (projected < r.usual * 1.5 || projected - r.usual < MIN_DELTA) continue;
    // projected === spent означає, що спрацював кеп: перевитрата вже СТАЛАСЬ, а не
    // «прогнозується». Казати про неї в майбутньому часі — брехати про стан справ.
    const already = projected <= r.spent;
    out.push({
      kind: "anomaly",
      title: `${r.name} — ${already ? "вже вище звичного" : "темп вище звичного"}`,
      body: already
        ? `Уже ${uah(r.spent)} проти звичних ${uah(r.usual)} за місяць (${Math.round((r.spent / r.usual) * 100)}%).`
        : `Уже ${uah(r.spent)}, за темпом місяць вийде ≈ ${uah(projected)} проти звичних ${uah(r.usual)} (${Math.round((projected / r.usual) * 100)}%).`,
      severity: "warn",
      entity_type: "category", entity_id: String(r.id),
      dedup_key: `anomaly:${r.id}:${pace.monthKey}`,
    });
  }
  return out.slice(0, 4);
}

/**
 * Перемога: категорія йде помітно НИЖЧЕ звичного рівня, і місяць уже здебільшого минув.
 * Стрічка не має бути суцільною тривогою — інакше її перестають відкривати. Це єдиний
 * позитивний тип, і він так само стоїть на канонічних цифрах, а не на компліментах.
 */
function draftWins(pace: MonthPace): Draft[] {
  if (pace.elapsedFrac < 0.6) return [];      // рано хвалити: місяць ще може все зіпсувати
  const out: Draft[] = [];
  for (const r of pace.rows) {
    if (r.usual < 100000) continue;           // <1000 ₴/міс — економія непомітна
    const projected = projectSpend(r.spent, r.usual, pace.elapsedFrac, false);
    if (projected > r.usual * 0.7) continue;  // треба щонайменше −30%
    const saved = r.usual - projected;
    if (saved < 30000) continue;              // <300 ₴ — не новина
    out.push({
      kind: "win",
      title: `${r.name} — нижче звичного на ${Math.round((saved / r.usual) * 100)}%`,
      body: `За темпом вийде ≈ ${uah(projected)} проти звичних ${uah(r.usual)}. Різниця ${uah(saved)}.`,
      severity: "info",
      entity_type: "category", entity_id: String(r.id),
      dedup_key: `win:${r.id}:${pace.monthKey}`,
    });
  }
  return out.slice(0, 2);
}

/** Бюджети-конверти: вичерпані (≥100%) або на межі (≥90%). Канон витрати — SPEND_WHERE. */
async function draftBudgets(env: Env, now: number): Promise<Draft[]> {
  const rates = await getRates(env.DB);
  const { mult } = valueMode(rates, null);
  const d = new Date(now * 1000);
  const monthStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
  const monthKey = new Date(now * 1000).toISOString().slice(0, 7);

  const [budgets, spend] = await Promise.all([
    env.DB.prepare(
      `SELECT b.category_id AS id, b.amount AS amount, c.name AS name
       FROM budgets b JOIN categories c ON c.id = b.category_id
       WHERE b.period = 'month' AND b.amount > 0`,
    ).all<{ id: number; amount: number; name: string }>(),
    env.DB.prepare(
      `SELECT ${EFF_CAT_ID} AS id, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
       GROUP BY ${EFF_CAT_ID}`,
    ).bind(monthStart, now).all<{ id: number | null; spent: number }>(),
  ]);

  const spentByCat = new Map<number, number>();
  for (const r of spend.results ?? []) if (r.id != null) spentByCat.set(r.id, r.spent);

  const out: Draft[] = [];
  for (const b of budgets.results ?? []) {
    const spent = spentByCat.get(b.id) ?? 0;
    const ratio = spent / b.amount;
    if (ratio < 0.9) continue;
    const over = ratio >= 1;
    out.push({
      kind: "budget",
      title: over ? `Бюджет «${b.name}» вичерпано` : `Бюджет «${b.name}» майже вичерпано`,
      body: `${uah(spent)} з ${uah(b.amount)} (${Math.round(ratio * 100)}%).`,
      severity: over ? "urgent" : "warn",
      entity_type: "category", entity_id: String(b.id),
      // Різні ключі для 90% і 100% — щоб «майже» не глушило подальше «вичерпано».
      dedup_key: `budget:${b.id}:${monthKey}:${over ? "over" : "warn"}`,
    });
  }
  return out;
}

/** Подорожчання підписки: остання фактична сума помітно вища за план (plannedActuals). */
async function draftPriceUps(env: Env): Promise<Draft[]> {
  const [actuals, plans] = await Promise.all([
    plannedActuals(env.DB),
    env.DB.prepare("SELECT id, title, period_amount FROM planned_payments WHERE is_active = 1")
      .all<{ id: number; title: string; period_amount: number | null }>(),
  ]);
  const titleById = new Map((plans.results ?? []).map((p) => [p.id, p]));

  const out: Draft[] = [];
  for (const a of actuals) {
    if (a.price_change_pct == null || a.price_change_pct < 10) continue;
    const p = titleById.get(a.id);
    if (!p || !p.period_amount || a.last_amount == null || a.last_time == null) continue;
    const delta = a.last_amount - p.period_amount;
    if (delta <= 0) continue;
    out.push({
      kind: "price_up",
      title: `${p.title} подорожчав на ${a.price_change_pct}%`,
      // Абсолютна дельта + вплив на рік читається краще за голий відсоток (як у Підписках).
      body: `Було ${uah(p.period_amount)}, стало ${uah(a.last_amount)} (+${uah(delta)} · ${uah(delta * 12)}/рік).`,
      severity: "warn",
      entity_type: "planned", entity_id: String(a.id),
      dedup_key: `price_up:${a.id}:${isoDay(a.last_time)}`,
    });
  }
  return out;
}

/** Провал ліквідності: подушка мінус усі планові списання йде в мінус у вікні 45 днів. */
async function draftLiquidity(env: Env, now: number): Promise<Draft[]> {
  const { fundsBreakdown } = await import("./advisor.ts");
  const [funds, rates, plans] = await Promise.all([
    fundsBreakdown(env),
    getRates(env.DB),
    env.DB.prepare(
      `SELECT id, title, period_amount, currency_code, period, period_count, start_date, end_date
       FROM planned_payments WHERE is_active = 1`,
    ).all<{
      id: number; title: string; period_amount: number | null; currency_code: number | null;
      period: string; period_count: number | null; start_date: number; end_date: number | null;
    }>(),
  ]);

  const horizon = now + 45 * 86400;
  const charges: { at: number; amount: number }[] = [];
  for (const p of plans.results ?? []) {
    const amt = p.period_amount ?? 0;
    if (amt <= 0) continue;
    const uahAmt = plannedUAH(amt, p.currency_code, rates);
    let t = nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, now);
    for (let guard = 0; guard < 200 && t <= horizon; guard++) {
      if (p.end_date != null && t > p.end_date) break;
      charges.push({ at: t, amount: uahAmt });
      t = nextChargeUnix(p.start_date, p.period, p.period_count ?? 1, t);
    }
  }
  charges.sort((a, b) => a.at - b.at);

  // Один прохід: перше падіння проєкції нижче нуля і є провалом.
  let balance = funds.cushion;
  for (const ch of charges) {
    balance -= ch.amount;
    if (balance >= 0) continue;
    return [{
      kind: "liquidity",
      title: "Прогнозований провал ліквідності",
      body: `На ${dayMonth(ch.at)} планових списань більше, ніж подушки: не вистачить ≈ ${uah(-balance)}. Подушка зараз ${uah(funds.cushion)}.`,
      severity: "urgent",
      entity_type: null, entity_id: null,
      dedup_key: `liquidity:${isoDay(ch.at)}`,
    }];
  }
  return [];
}

// ⚠️ Гілки нижче свідомо працюють з `t.amount`, а НЕ з канонічним `EFF_AMOUNT`/STATS_JOINS:
// це подієві сигнали про ОДНУ ОПЕРАЦІЮ (великий чек, дубль списання), а не агрегати по
// категоріях. Спліт ділить операцію на частини для КАТЕГОРІЙНОЇ аналітики, але з погляду
// банку це одне списання однією сумою — саме її і треба показати. Фільтри витрати
// повторюють суть `SPEND_WHERE` на рівні рядка (без рол-апу категорій).
const TX_SPEND = "t.amount < 0 AND t.transfer_pair_id IS NULL AND t.is_transfer = 0";

/**
 * Незвично велика ОДНА витрата: ≥3× середнього чека своєї категорії за 90 днів.
 *
 * ⚠️ Регулярне виключаємо канонічним `isRecurringExpr` (підписка/розстрочка за `planned_id`
 * АБО мерчант із витратами в ≥3 різних місяцях). Без цього оренда 12 500 ₴ щомісяця летіла б
 * у стрічку як «велика витрата» — перевірено на реальних даних. Регулярний платіж великий
 * за визначенням і користувач про нього знає; новина — лише НЕсподіваний великий чек.
 */
async function draftBigTx(env: Env, now: number): Promise<Draft[]> {
  const MIN_ABS = 50000;                      // 500 ₴ — нижче не сигнал, хоч би який множник
  const notRecurring = `NOT ${isRecurringExpr(defaultRefFrom(now), now)}`;
  const rows = await env.DB.prepare(
    `WITH avg_check AS (
       SELECT t.category_id AS cat, AVG(-t.amount) AS avg_amt, COUNT(*) AS n
       FROM transactions t
       WHERE t.time >= ? AND t.time < ? AND ${TX_SPEND}
       GROUP BY t.category_id
     )
     SELECT t.id AS id, t.merchant AS merchant, -t.amount AS amount, t.time AS time,
            c.name AS category, a.avg_amt AS avg_amt
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     JOIN avg_check a ON a.cat IS t.category_id
     WHERE t.time >= ? AND ${TX_SPEND} AND a.n >= 5 AND ${notRecurring}
       AND -t.amount >= ? AND -t.amount >= a.avg_amt * 3
     ORDER BY t.amount ASC LIMIT 3`,
  ).bind(now - 90 * 86400, now - 2 * 86400, now - 2 * 86400, MIN_ABS)
    .all<{ id: string; merchant: string | null; amount: number; time: number; category: string | null; avg_amt: number }>();

  return (rows.results ?? []).map((r) => ({
    kind: "big_tx" as const,
    title: `Велика витрата: ${r.merchant ?? "без назви"}`,
    body: `${uah(r.amount)} — це ×${(r.amount / r.avg_amt).toFixed(1)} до звичного чека в категорії «${r.category ?? "без категорії"}» (${uah(Math.round(r.avg_amt))}).`,
    severity: "info" as const,
    entity_type: "tx", entity_id: r.id,
    dedup_key: `big_tx:${r.id}`,
  }));
}

/** Дубль списання: той самий мерчант і та сама сума у вікні доби. Термінал/подвійний тап. */
async function draftDuplicates(env: Env, now: number): Promise<Draft[]> {
  const rows = await env.DB.prepare(
    `SELECT a.id AS id, b.id AS other_id, a.merchant AS merchant, -a.amount AS amount, a.time AS time
     FROM transactions a
     JOIN transactions b ON b.merchant = a.merchant AND b.amount = a.amount AND b.id <> a.id
       AND b.time BETWEEN a.time - 86400 AND a.time + 86400
     WHERE a.time >= ? AND ${TX_SPEND.replace(/t\./g, "a.")}
       AND a.merchant IS NOT NULL AND a.merchant <> '' AND -a.amount >= 5000
     ORDER BY a.time DESC LIMIT 20`,
  ).bind(now - 3 * 86400)
    .all<{ id: string; other_id: string; merchant: string; amount: number; time: number }>();

  const seen = new Set<string>();
  const out: Draft[] = [];
  for (const r of rows.results ?? []) {
    // Джойн дає обидва напрямки (A→B і B→A) — ключ із відсортованої пари згортає їх в одне.
    const pair = [r.id, r.other_id].sort().join("~");
    if (seen.has(pair)) continue;
    seen.add(pair);
    out.push({
      kind: "duplicate",
      title: `Схоже на подвійне списання: ${r.merchant}`,
      body: `Дві операції по ${uah(r.amount)} протягом доби. Перевір, чи це не помилка терміналу.`,
      severity: "warn",
      entity_type: "tx", entity_id: r.id,
      dedup_key: `duplicate:${pair}`,
    });
    if (out.length >= 3) break;
  }
  return out;
}

/** Індекс фінздоровʼя помітно просів проти минулого тижня (дані з health_history). */
async function draftHealthDrop(env: Env, now: number): Promise<Draft[]> {
  const rows = await env.DB.prepare(
    "SELECT day, score FROM health_history WHERE ts >= ? ORDER BY ts DESC LIMIT 30",
  ).bind(now - 30 * 86400).all<{ day: string; score: number }>();
  const hist = rows.results ?? [];
  if (hist.length < 2) return [];

  const latest = hist[0];
  // Порівнюємо з найсвіжішим записом, старшим за 5 днів — щоб не ловити добовий шум.
  const cutoff = new Date((now - 5 * 86400) * 1000).toISOString().slice(0, 10);
  const past = hist.find((h) => h.day <= cutoff);
  if (!past) return [];
  const drop = past.score - latest.score;
  if (drop < 8) return [];

  return [{
    kind: "health_drop",
    title: `Індекс фінздоровʼя впав на ${drop} п.`,
    body: `Було ${past.score} (${past.day}), стало ${latest.score}. Відкрий «Стан фінансів» — там видно, яка складова просіла.`,
    severity: "warn",
    entity_type: null, entity_id: null,
    dedup_key: `health_drop:${latest.day}`,
  }];
}

/** Ціль не встигає: прогрес відстає від часу, що минув, або дедлайн уже близько. */
async function draftGoalRisk(env: Env, now: number): Promise<Draft[]> {
  const rows = await env.DB.prepare(
    `SELECT g.id, g.name, g.target_amount, g.current_amount, g.deadline, g.created_at,
            a.balance AS account_balance
     FROM savings_goals g LEFT JOIN accounts a ON a.id = g.account_id
     WHERE g.is_active = 1 AND g.deadline IS NOT NULL AND g.target_amount > 0`,
  ).all<{
    id: number; name: string; target_amount: number; current_amount: number;
    deadline: number; created_at: number | null; account_balance: number | null;
  }>();

  const out: Draft[] = [];
  const today = isoDay(now);
  for (const g of rows.results ?? []) {
    const current = g.account_balance ?? g.current_amount;   // банка-джерело має пріоритет
    if (current >= g.target_amount) continue;                 // вже зібрано
    const start = g.created_at ?? g.deadline - 180 * 86400;
    if (g.deadline <= start) continue;
    const progressFrac = current / g.target_amount;
    const elapsedFrac = (now - start) / (g.deadline - start);
    const daysLeft = Math.round((g.deadline - now) / 86400);
    // Ризик = час іде помітно швидше за гроші (розрив >15 п.п.), АБО дедлайн уже за тиждень.
    const behind = elapsedFrac - progressFrac;
    if (behind < 0.15 && daysLeft > 7) continue;
    const need = g.target_amount - current;
    const perMonth = daysLeft > 0 ? Math.round(need / Math.max(1, daysLeft / 30)) : need;
    out.push({
      kind: "goal_risk",
      title: daysLeft <= 0 ? `Дедлайн цілі «${g.name}» минув` : `Ціль «${g.name}» не встигає`,
      body: daysLeft <= 0
        ? `Зібрано ${uah(current)} з ${uah(g.target_amount)} (${Math.round(progressFrac * 100)}%).`
        : `Зібрано ${Math.round(progressFrac * 100)}%, а часу минуло ${Math.round(elapsedFrac * 100)}%. Щоб устигнути — ${uah(perMonth)}/міс (лишилось ${daysLeft} дн).`,
      severity: daysLeft <= 7 ? "warn" : "info",
      entity_type: "goal", entity_id: String(g.id),
      // Раз на тиждень: щоденне нагадування про ту саму ціль — це вже докучання.
      dedup_key: `goal_risk:${g.id}:${today.slice(0, 8)}${Math.floor(Number(today.slice(8)) / 7)}`,
    });
  }
  return out.slice(0, 3);
}

/** «Мертва» підписка: активна понад 60 днів, а жодного фактичного списання не видно. */
async function draftDeadSubs(env: Env, now: number): Promise<Draft[]> {
  const [actuals, plans] = await Promise.all([
    plannedActuals(env.DB),
    env.DB.prepare(
      "SELECT id, title, period_amount, currency_code, start_date FROM planned_payments WHERE is_active = 1",
    ).all<{ id: number; title: string; period_amount: number | null; currency_code: number | null; start_date: number }>(),
  ]);
  const rates = await getRates(env.DB);
  const countById = new Map(actuals.map((a) => [a.id, a.count]));

  const out: Draft[] = [];
  for (const p of plans.results ?? []) {
    if (now - p.start_date < 60 * 86400) continue;   // ще молода — рано судити
    if ((countById.get(p.id) ?? 0) > 0) continue;    // списання бачимо
    const perMonth = plannedUAH(p.period_amount, p.currency_code, rates);
    out.push({
      kind: "dead_sub",
      title: `${p.title} — списань не видно`,
      body: perMonth > 0
        ? `План на ${uah(perMonth)}/міс активний понад 60 днів, але жодної операції до нього не привʼязано. Або підписки вже нема, або списання не розпізналось.`
        : "План активний понад 60 днів без жодного фактичного списання.",
      severity: "info",
      entity_type: "planned", entity_id: String(p.id),
      dedup_key: `dead_sub:${p.id}:${isoDay(now).slice(0, 7)}`,   // раз на місяць
    });
  }
  return out.slice(0, 3);
}

/** Операційний борг: багато витрат без категорії — вся аналітика через це бреше. */
async function draftTodo(env: Env, now: number): Promise<Draft[]> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM transactions t
     WHERE t.time >= ? AND ${TX_SPEND} AND t.category_id IS NULL`,
  ).bind(now - 30 * 86400).first<{ n: number }>();
  const n = r?.n ?? 0;
  if (n < 10) return [];

  // Тижнева каденція: щоденне нагадування про ту саму купу — це докучання.
  const week = Math.floor(now / (7 * 86400));
  return [{
    kind: "todo",
    title: `${n} операцій без категорії`,
    body: "За останні 30 днів. Поки вони без категорії — статистика, бюджети й поради рахують не все.",
    severity: "info",
    entity_type: null, entity_id: null,
    dedup_key: `todo:uncategorized:${week}`,
  }];
}

/**
 * AI-ініціатива: модель дивиться на ГОТОВИЙ канонічний знімок (`collectFinanceSnapshot` —
 * те саме джерело, що Порадник і Чат) і формулює 1-2 спостереження людською мовою.
 *
 * 🔒 Модель НЕ рахує — вона лише називає те, що вже пораховано канонічно. Це головна
 * різниця з «тупими алертами» й водночас запобіжник: вигадану цифру тут ніде взяти,
 * бо в промті прямо заборонено рахувати нові числа.
 */
async function draftAiObservations(env: Env, now: number): Promise<Draft[]> {
  if (!env.ANTHROPIC_API_KEY) return [];
  const day = isoDay(now);
  // 💸 Запобіжник вартості: `dedup_key` захищає лише від дублів У БАЗІ, а виклик моделі
  // стався б однаково. Без цієї перевірки кнопка «Перевірити зараз» палила б токени на
  // кожен клік. За добу — рівно один прохід.
  const already = await env.DB.prepare(
    "SELECT 1 AS x FROM notifications WHERE kind = 'ai' AND dedup_key LIKE ? LIMIT 1",
  ).bind(`ai:${day}:%`).first<{ x: number }>();
  if (already) return [];

  const { collectFinanceSnapshot } = await import("./advisor.ts");
  const { generateNotifyObservations } = await import("./ai.ts");

  // ЄДИНЕ джерело контексту — той самий знімок, що бачать Порадник і Чат (§Інваріанти).
  // Не будувати збіднений контекст вручну: саме це колись дало «домислену подушку $780».
  const snap = await collectFinanceSnapshot(env);
  const { result } = await generateNotifyObservations(env, snap.context);

  return (result.observations ?? [])
    .filter((o) => o.title?.trim())
    .slice(0, 2)   // ліміт на добу — стрічка не має тонути в балачках моделі
    .map((o, i) => ({
      kind: "ai" as const,
      title: o.title!.trim().slice(0, 120),
      body: (o.body ?? "").trim().slice(0, 400) || null,
      severity: o.severity === "warn" ? ("warn" as const) : ("info" as const),
      entity_type: null, entity_id: null,
      dedup_key: `ai:${day}:${i}`,
    }));
}

// ---- TG-пуш + ретеншн --------------------------------------------------------

const TG_ICON: Record<Severity, string> = { info: "•", warn: "🟠", urgent: "🔴" };
const tgEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Пуш у Telegram — ЛИШЕ важливе (`severity >= warn`). Решта живе тільки в застосунку:
 * якщо слати все, сповіщення почнуть ігнорувати, і важливе загубиться разом з рештою.
 * `pushed_tg_at` захищає від повторів (крон ганяється щодня по тій самій таблиці).
 */
export async function pushPendingToTelegram(env: Env): Promise<{ sent: number; reason?: string }> {
  const token = env.TG_BOT_TOKEN, chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return { sent: 0, reason: "TG not configured" };

  const rows = await env.DB.prepare(
    `SELECT id, kind, title, body, severity FROM notifications
     WHERE pushed_tg_at IS NULL AND severity IN ('warn','urgent')
     ORDER BY created_at ASC LIMIT 10`,
  ).all<{ id: number; kind: string; title: string; body: string | null; severity: Severity }>();
  const items = rows.results ?? [];
  if (!items.length) return { sent: 0 };

  const { sendMessage } = await import("./telegram.ts");
  const lines = items.map((n) => `${TG_ICON[n.severity]} <b>${tgEsc(n.title)}</b>${n.body ? `\n${tgEsc(n.body)}` : ""}`);
  await sendMessage(token, chatId, `🔔 Money Track\n\n${lines.join("\n\n")}`);

  const now = Math.floor(Date.now() / 1000);
  const holes = items.map(() => "?").join(",");
  await env.DB.prepare(`UPDATE notifications SET pushed_tg_at = ? WHERE id IN (${holes})`)
    .bind(now, ...items.map((n) => n.id)).run();
  return { sent: items.length };
}

/** Ретеншн: прибираємо ПРОЧИТАНІ старші за RETENTION_DAYS. Непрочитані лишаються назавжди. */
export async function pruneNotifications(env: Env, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const res = await env.DB.prepare(
    "DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?",
  ).bind(now - RETENTION_DAYS * 86400).run();
  return res.meta.changes ?? 0;
}

/**
 * Добова генерація стрічки. Детерміновані гілки + один AI-прохід (`ai`, Haiku, ≤2 події).
 * Кожна гілка ізольована: впала одна — решта все одно доїде.
 */
export async function generateNotifications(
  env: Env, now = Math.floor(Date.now() / 1000),
): Promise<{ created: number; pushed: number; pruned: number; skipped: string[] }> {
  const prefs = await getPrefs(env);
  const skipped: string[] = [];

  // `anomaly` і `win` дивляться на ту саму базу — рахуємо її раз і лише якщо треба.
  let pace: MonthPace | null = null;
  const getPace = async () => (pace ??= await monthPace(env, now));

  const branches: [NotifKind, () => Promise<Draft[]>][] = [
    ["report", () => draftReports(env, now)],
    ["deadline", () => draftDeadlines(env, now)],
    ["anomaly", async () => draftAnomalies(await getPace())],
    ["budget", () => draftBudgets(env, now)],
    ["price_up", () => draftPriceUps(env)],
    ["liquidity", () => draftLiquidity(env, now)],
    ["big_tx", () => draftBigTx(env, now)],
    ["duplicate", () => draftDuplicates(env, now)],
    ["health_drop", () => draftHealthDrop(env, now)],
    ["goal_risk", () => draftGoalRisk(env, now)],
    ["dead_sub", () => draftDeadSubs(env, now)],
    ["win", async () => draftWins(await getPace())],
    ["todo", () => draftTodo(env, now)],
    ["ai", () => draftAiObservations(env, now)],
  ];

  const drafts: Draft[] = [];
  for (const [kind, run] of branches) {
    if (!prefs[kind]) continue;                 // тип вимкнено користувачем
    try {
      drafts.push(...(await run()));
    } catch (e) {
      skipped.push(`${kind}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Категорія з перевитраченим бюджетом не потребує ще й сповіщення про темп: обидва
  // кажуть те саме тими самими цифрами («Транспорт 1 314 ₴» двічі поспіль — спіймано
  // на реальному запуску). Бюджет конкретніший (є ліміт, з яким порівнювати) — лишаємо його.
  const budgetCats = new Set(
    drafts.filter((d) => d.kind === "budget" && d.entity_id).map((d) => d.entity_id!),
  );
  const deduped = drafts.filter((d) => !(d.kind === "anomaly" && d.entity_id && budgetCats.has(d.entity_id)));

  // Спершу найважливіше — якщо впремось у ліміт, зріжеться саме дрібне.
  const rank: Record<Severity, number> = { urgent: 0, warn: 1, info: 2 };
  deduped.sort((a, b) => rank[a.severity ?? "info"] - rank[b.severity ?? "info"]);

  let created = 0;
  for (const d of deduped) {
    // Ліміт рахуємо по СТВОРЕНИХ, а не по переглянутих: інакше десяток уже наявних
    // (і мовчки проігнорованих) чернеток зʼїдав би квоту й глушив справді нові події.
    if (created >= MAX_PER_RUN) break;
    // INSERT OR IGNORE + UNIQUE(dedup_key): крон щодня бачить ті самі події — вставиться
    // лише те, чого ще не було. `changes` каже, чи справді додався рядок.
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO notifications
         (kind, title, body, severity, entity_type, entity_id, dedup_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      d.kind, d.title, d.body ?? null, d.severity ?? "info",
      d.entity_type ?? null, d.entity_id ?? null, d.dedup_key, now,
    ).run();
    if (res.meta.changes > 0) created++;
  }

  // Пуш і прибирання — теж best-effort: збій TG не має валити саму генерацію.
  let pushed = 0;
  try { pushed = (await pushPendingToTelegram(env)).sent; }
  catch (e) { skipped.push(`telegram: ${e instanceof Error ? e.message : String(e)}`); }
  let pruned = 0;
  try { pruned = await pruneNotifications(env, now); }
  catch (e) { skipped.push(`prune: ${e instanceof Error ? e.message : String(e)}`); }

  return { created, pushed, pruned, skipped };
}
