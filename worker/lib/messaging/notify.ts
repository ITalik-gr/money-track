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
import type { Env } from "../../env.ts";
import { debtMinor } from "../finance/own-funds.ts";
import { getRates } from "../finance/finance.ts";
import { st, resolveLocale } from "../platform/i18n.ts";
import { nextChargeUnix, plannedUAH, plannedActuals, chargesBetween } from "../finance/subscriptions.ts";
import { goalPace, goalNeedsAttention } from "../finance/goals.ts";
import {
  STATS_JOINS, SPEND_WHERE, EFF_CAT_ID, EFF_CAT_NAME, amountSum, valueMode,
  categoryMonthlyLevels, projectSpend, isRecurringExpr, defaultRefFrom,
  localMonthStart, localYm, localYmd,
} from "../finance/stats.ts";
import { draftBudgets, draftBudgetForecast } from "./drafts-budget.ts";
import { getState, setState } from "../finance/repo.ts";
import { renderNotif, type NotifTemplateKey, type NotifParams } from "../../../shared/notif-i18n.ts";

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
  // Template key + raw params for locale-aware re-rendering at read time (P3.3). NULL for the
  // free-text `ai` kind and for rows written before migration 0033 — those fall back to
  // title/body. `notif_params` is a JSON string.
  notif_key: NotifTemplateKey | null;
  notif_params: string | null;
  severity: Severity;
  entity_type: string | null;
  entity_id: string | null;
  created_at: number;
  read_at: number | null;
}

// A generated event. Deterministic kinds carry a template `tkey` + `tparams` (composed into
// title/body at insert time in the owner's locale, and re-composed client-side on a language
// switch). The free-text `ai` kind instead carries a ready `title`/`body` from the model.
export interface Draft {
  kind: NotifKind;
  tkey?: NotifTemplateKey;
  tparams?: NotifParams;
  title?: string;
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
  const sql = `SELECT id, kind, title, body, notif_key, notif_params, severity, entity_type, entity_id, created_at, read_at
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

// §APP_TZ: доба ключа — КИЇВСЬКА, не UTC. Воркер живе в UTC, тож `toISOString()` до 03:00 за
// Києвом віддавав учорашню дату: подія, згенерована вночі (напр. кнопкою «Перевірити зараз»),
// підписувалась учорашнім днем і зливалась дедупом із учорашньою — а «сьогодні» в місячних
// гілках нижче рахується від `localMonthStart`, тобто вже по-київськи. Дві різні доби в одному
// файлі — це і є те, як подія тихо зникає.
const isoDay = (unix: number) => localYmd(unix);

// Language for the stored fallback title/body and the TG push. `resolveLocale` (reader first,
// stored preference second) — the feed itself re-renders client-side, so this only affects the
// fallback path, but it must not be a fifth answer to the same question.

/**
 * Записати чернетки у стрічку. ЄДИНЕ місце, де подія стає рядком.
 *
 * Винесено з `generateNotifications`, коли зʼявився другий писар (§A6: фонова AI-задача
 * оголошує себе одразу після завершення, не чекаючи добового крону). Два незалежні
 * `INSERT INTO notifications` розійшлись би на першій же зміні — напр. рядок без
 * `notif_key` замерз би однією мовою, хоча вся суть P3.3 у зворотному.
 */
async function insertDrafts(env: Env, drafts: Draft[], now: number, max = MAX_PER_RUN): Promise<number> {
  // Fallback title/body are composed in the owner's locale at insert (P3.3): they serve
  // legacy/`ai` rows and TG. The client re-renders templated rows live from key/params.
  const locale = await resolveLocale(env);
  let created = 0;
  for (const d of drafts) {
    // Ліміт рахуємо по СТВОРЕНИХ, а не по переглянутих: інакше десяток уже наявних
    // (і мовчки проігнорованих) чернеток зʼїдав би квоту й глушив справді нові події.
    if (created >= max) break;
    let title = d.title ?? "";
    let body: string | null = d.body ?? null;
    if (d.tkey) {
      const r = renderNotif(locale, d.tkey, d.tparams ?? {});
      title = r.title;
      body = r.body;
    }
    // INSERT OR IGNORE + UNIQUE(dedup_key): крон щодня бачить ті самі події — вставиться
    // лише те, чого ще не було. `changes` каже, чи справді додався рядок.
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO notifications
         (kind, title, body, notif_key, notif_params, severity, entity_type, entity_id, dedup_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      d.kind, title, body, d.tkey ?? null, d.tparams ? JSON.stringify(d.tparams) : null,
      d.severity ?? "info", d.entity_type ?? null, d.entity_id ?? null, d.dedup_key, now,
    ).run();
    if (res.meta.changes > 0) created++;
  }
  return created;
}

/**
 * §A6 — фонова AI-задача завершилась: рядок у стрічку ОДРАЗУ, а не з наступним кроном.
 *
 * Це половина сценарію «закрив вкладку»: тост побачить лише той, хто повернувся, а стрічка —
 * слід для всіх інших. Правило «подія оголошується в тому ж прогоні, що й народилась» тут
 * буквальне: чекати добового проходу означало б сповіщення про пораду через день після поради.
 *
 * Для `report` навмисно перевикористано `draftReports` із тим самим `dedup_key` (`report:<id>`) —
 * інакше та сама подія лягла б у стрічку двічі: раз звідси, раз із крону.
 * Провал задачі у стрічку НЕ пишемо: користувач і так побачить його тостом із `GET /api/jobs`,
 * а рядок «не вдалось» у журналі подій — це шум, а не подія його фінансів.
 */
export async function pushJobNotification(
  env: Env, kind: "advisor" | "report" | "budget", jobId: number, error: string | null,
  auto = false,
): Promise<void> {
  if (error) return;
  // Що поставив РОЗКЛАД — це та сама «ініціатива системи», що й AI-спостереження, тож і
  // вимикається тим самим перемикачем. Що запустила людина — оголошуємо завжди: сховати
  // результат дії, яку вона щойно замовила, було б не тишею, а зникненням роботи.
  if (auto && !(await getPrefs(env))[kind === "report" ? "report" : "ai"]) return;
  const now = Math.floor(Date.now() / 1000);
  if (kind === "report") {
    await insertDrafts(env, await draftReports(env, now), now);
    return;
  }
  await insertDrafts(env, [{
    kind: "ai",
    tkey: "job_done",
    // `auto` — задачу поставив КРОН, а не користувач (місячне оновлення поради 1-го числа).
    // Без цієї позначки рядок читався як «твоя генерація готова» на щось, чого людина не
    // запускала: 1 серпня о 12:00 порада «згенерувалась сама», і це виглядало як збій, а не
    // як фіча (скарга 2026-08-01). Текст мусить казати, ЧОМУ подія зʼявилась.
    tparams: { job: kind, auto },
    severity: "info",
    // Перехід: порада живе на Пораднику, план бюджетів — у Плані. Без сутності рядок був
    // тупиком — повідомляв, що щось готове, і не вів туди, де це подивитись.
    entity_type: kind === "budget" ? "budget_plan" : "advice",
    entity_id: null,
    // Ключ по id задачі: кожен ЗАПУСК — окрема подія, яку користувач сам замовив. Ключ із
    // датою («job:advisor:2026-08-01») зробив би два запуски за день одним рядком.
    dedup_key: `job:${kind}:${jobId}`,
  }], now);
}

/**
 * A scheduled step that threw — announced to the person it was scheduled for.
 *
 * Reported by the owner as "there is no report for last week". It was not missing: the generation
 * failed, `runCron`'s `step()` caught it into `failed`, the Worker wrote one `console.error`, and
 * that was the end of it. From inside the app "the report failed" and "the report was never due"
 * look exactly the same, so a broken key or a model outage could go unnoticed for weeks — the
 * whole `weekly_report` branch is behind `if (env.ANTHROPIC_API_KEY)` and skips in silence too.
 *
 * ⚠️ Deduped per STEP per DAY (`localYmd`, §APP_TZ — the same Kyiv day as every other key in this
 * file). A key that is permanently broken fails on every run; without the day in the key the feed
 * would carry one row forever, and with a timestamp in it the feed would be nothing but this.
 * ⚠️ Severity `warn`, not `urgent`: nothing about the user's money is wrong. Something the app
 * promised to do did not happen, which is the app's problem, honestly reported.
 * ⚠️ Not gated on any preference. Every other kind can be switched off because it is an OPINION
 * about the data; this one is a statement that the product did not do its job, and a product that
 * lets you mute that is lying by omission.
 */
export async function announceCronFailures(
  env: Env, failures: string[], now = Math.floor(Date.now() / 1000),
): Promise<number> {
  if (!failures.length) return 0;
  const day = localYmd(now);
  const drafts: Draft[] = failures.slice(0, 3).map((f) => {
    // `step()` formats these as "name: message"; split on the FIRST colon only, because the
    // message itself routinely contains more of them (URLs, "Error: ...").
    const i = f.indexOf(":");
    const step = i > 0 ? f.slice(0, i) : f;
    const reason = i > 0 ? f.slice(i + 1).trim() : "";
    return {
      kind: "todo",
      tkey: "cron_failed",
      tparams: { step, reason: reason || "no details" },
      severity: "warn",
      entity_type: null,
      entity_id: null,
      dedup_key: `cron_failed:${step}:${day}`,
    };
  });
  return insertDrafts(env, drafts, now);
}

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
    // Тіло — короткий витяг (AI-текст, не локалізується), клік веде на /reports/:id.
    tkey: "report" as const,
    tparams: {
      periodType: r.period_type, from: r.period_from, to: r.period_to,
      summary: (r.summary ?? "").slice(0, 220),
    },
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
    out.push({
      kind: "deadline",
      tkey: "deadline_plan",
      tparams: { title: p.title, days, amount: amountUAH, at },
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
    // Борг — це відʼємні власні кошти, а не окрема формула (§Інваріанти, `own-funds.ts`).
    // Писати тут `credit_limit − balance` вдруге означало б завести другий вираз для одного
    // числа — саме це реєстр дублювання й прийняв був за «інвертовану копію».
    const used = debtMinor(a.balance, a.credit_limit);
    if (used <= 0) continue;                                // нема боргу — нема про що нагадувати
    const at = nextMonthlyDay(a.payment_day!, now);
    const days = Math.round((at - now) / 86400);
    if (days > 3) continue;
    const amt = a.min_payment && a.min_payment > 0 ? a.min_payment : used;
    const amtUAH = plannedUAH(amt, a.currency_code, rates);
    const isMin = !!(a.min_payment && a.min_payment > 0);
    out.push({
      kind: "deadline",
      tkey: "deadline_credit",
      tparams: { title: a.title, days, isMin, amount: amtUAH, at },
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
  const monthStart = localMonthStart(now);
  const nextMonthStart = localMonthStart(now, 1);
  const elapsedFrac = Math.min(1, Math.max(0.02, (now - monthStart) / (nextMonthStart - monthStart)));

  const levels = await categoryMonthlyLevels(env, mult, { now });
  const cur = await env.DB.prepare(
    `SELECT ${EFF_CAT_ID} AS id, ${EFF_CAT_NAME} AS name, ${amountSum(mult)} AS spent,
            COUNT(DISTINCT t.id) AS n
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}
     GROUP BY ${EFF_CAT_ID}`,
  ).bind(monthStart, now).all<{ id: number | null; name: string | null; spent: number; n: number }>();

  const loc = await resolveLocale(env);
  const rows = (cur.results ?? [])
    .filter((r): r is { id: number; name: string | null; spent: number; n: number } => r.id != null)
    .map((r) => ({ id: r.id, name: r.name ?? st(loc, "uncategorized"), spent: r.spent, n: r.n, usual: levels.get(r.id)?.level ?? 0 }));
  // Ключ місяця — той самий локальний місяць, що й `monthStart` вище (§APP_TZ).
  return { monthKey: localYm(now), elapsedFrac, rows };
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
    const pct = Math.round(((already ? r.spent : projected) / r.usual) * 100);
    out.push({
      kind: "anomaly",
      tkey: "anomaly",
      tparams: { name: r.name, already, spent: r.spent, usual: r.usual, projected, pct },
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
      tkey: "win",
      tparams: { name: r.name, pct: Math.round((saved / r.usual) * 100), projected, usual: r.usual, saved },
      severity: "info",
      entity_type: "category", entity_id: String(r.id),
      dedup_key: `win:${r.id}:${pace.monthKey}`,
    });
  }
  return out.slice(0, 2);
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
      // Абсолютна дельта + вплив на рік читається краще за голий відсоток (як у Підписках).
      tkey: "price_up",
      tparams: {
        title: p.title, pct: a.price_change_pct,
        old: p.period_amount, new: a.last_amount, delta, year: delta * 12,
      },
      severity: "warn",
      entity_type: "planned", entity_id: String(a.id),
      dedup_key: `price_up:${a.id}:${isoDay(a.last_time)}`,
    });
  }
  return out;
}

/** Провал ліквідності: подушка мінус усі планові списання йде в мінус у вікні 45 днів. */
async function draftLiquidity(env: Env, now: number): Promise<Draft[]> {
  const { fundsBreakdown } = await import("../ai/advisor.ts");
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

  // §SUB-MONTH: розклад — канонічний `chargesBetween` (той самий, що в календарі й прогнозі).
  const charges = chargesBetween(plans.results ?? [], rates, now + 1, now + 45 * 86400);

  // Один прохід: перше падіння проєкції нижче нуля і є провалом.
  let balance = funds.cushion;
  for (const ch of charges) {
    balance -= ch.amount;
    if (balance >= 0) continue;
    return [{
      kind: "liquidity",
      tkey: "liquidity",
      tparams: { at: ch.at, short: -balance, cushion: funds.cushion },
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
    tkey: "big_tx" as const,
    tparams: {
      merchant: r.merchant, amount: r.amount, mult: (r.amount / r.avg_amt).toFixed(1),
      category: r.category, avg: Math.round(r.avg_amt),
    },
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
      tkey: "duplicate",
      tparams: { merchant: r.merchant, amount: r.amount },
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
  const cutoff = isoDay(now - 5 * 86400);
  const past = hist.find((h) => h.day <= cutoff);
  if (!past) return [];
  const drop = past.score - latest.score;
  if (drop < 8) return [];

  return [{
    kind: "health_drop",
    tkey: "health_drop",
    tparams: { drop, pastScore: past.score, pastDay: past.day, latestScore: latest.score },
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
    // §GOAL-PACE: the same computation the goal card itself displays. Until now this drafter had
    // its own arithmetic, so the feed could name a monthly rate written nowhere on the goal.
    const p = goalPace({ ...g, current }, now);
    if (!goalNeedsAttention(p)) continue;
    // A sprint (<1 month) has no monthly rate — the only meaningful figure there is the whole
    // remaining amount. That is exactly what the drafter used to show via `max(1, days / 30)`.
    const perMonth = p.per_month ?? p.left;
    out.push({
      kind: "goal_risk",
      tkey: "goal_risk",
      tparams: {
        name: g.name, passed: p.status === "overdue",
        current, target: g.target_amount, progressPct: Math.round(p.progress_frac * 100),
        elapsedPct: Math.round((p.elapsed_frac ?? 0) * 100), perMonth, daysLeft: p.days_left ?? 0,
      },
      severity: p.status === "overdue" || p.status === "at_risk" ? "warn" : "info",
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
      tkey: "dead_sub",
      tparams: { title: p.title, perMonth },
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
    tkey: "todo",
    tparams: { n },
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
/**
 * 🔒 Детермінований запобіжник проти вигаданих сум.
 *
 * Промт уже забороняє рахувати нові числа — і цього НЕ ВИСТАЧИЛО: на реальних даних модель
 * в ОДНОМУ сповіщенні назвала суму підписок у заголовку, а в тілі — іншу, більшу, «зі стелі»
 * (дві різні цифри про одне й те саме), плюс приписала сумі період, якого в payload не було.
 * Жодне з цих чисел у payload не існувало. Інструкція — не гарантія; гарантія — перевірка.
 *
 * Правило: КОЖНЕ число ≥ 100 у тексті мусить знайтися в payload. Дрібні (< 100) пропускаємо
 * свідомо — це кількості, дні, місяці, відсотки («8 підписок», «на 1-2 місяці»), і вимагати
 * для них джерела означало б глушити нормальні формулювання. Гроші — те, що бреше дорого.
 * Допуск 1% — модель округлює копійки до цілих гривень.
 *
 * Спостереження з непідтвердженим числом ВІДКИДАЄМО цілком, а не чистимо текст: фраза без
 * своєї цифри втрачає сенс, а стрічка з правилом «мовчання краще за шум» це витримує.
 */
function collectNumbers(v: unknown, out: Set<number>, depth = 0): void {
  if (depth > 6 || out.size > 5000) return;
  if (typeof v === "number") { if (Number.isFinite(v)) out.add(Math.abs(v)); return; }
  if (typeof v === "string") { const n = Number(v.replace(",", ".")); if (v.trim() && Number.isFinite(n)) out.add(Math.abs(n)); return; }
  if (Array.isArray(v)) { for (const x of v) collectNumbers(x, out, depth + 1); return; }
  if (v && typeof v === "object") { for (const x of Object.values(v)) collectNumbers(x, out, depth + 1); }
}

export function numbersAreGrounded(text: string, known: Set<number>): boolean {
  // Пробіли/нерозривні пробіли всередині числа — це розрядні роздільники («3 354»).
  const found = text.match(/\d[\d\s  ]*(?:[.,]\d+)?/g) ?? [];
  for (const raw of found) {
    const n = Math.abs(Number(raw.replace(/[\s  ]/g, "").replace(",", ".")));
    if (!Number.isFinite(n) || n < 100) continue;
    let ok = false;
    for (const k of known) {
      if (Math.abs(n - k) <= Math.max(1, k * 0.01)) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

/** Скільки днів одна тема AI-спостереження вважається «вже сказаною». */
const AI_TOPIC_COOLDOWN_DAYS = 14;
/** Ключ у `app_state`: доба, в яку AI-прохід уже відбувся. */
const AI_LAST_DAY_KEY = "notify_ai_day";

/**
 * Стабільний ключ ТЕМИ спостереження з його заголовка.
 *
 * Числа й пунктуацію викидаємо навмисно: та сама думка щодня приходить із трохи іншою сумою
 * («запасу на 7,5 місяця» → «запасу на 7,3 місяця»), і саме через це вона щоранку виглядала
 * як нова подія й летіла в Telegram. Лишається сама фраза — вона і є темою.
 */
function aiTopicKey(title: string): string {
  const norm = title.toLowerCase().replace(/[\d]+/g, " ").replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
  // FNV-1a: короткий детермінований ключ, який влазить у `entity_id` і однаковий між рестартами.
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

async function draftAiObservations(env: Env, now: number): Promise<Draft[]> {
  if (!env.ANTHROPIC_API_KEY) return [];
  const day = isoDay(now);
  // 💸 Запобіжник вартості: `dedup_key` захищає лише від дублів У БАЗІ, а виклик моделі
  // стався б однаково. Без цієї перевірки кнопка «Перевірити зараз» палила б токени на
  // кожен клік. За добу — рівно один прохід.
  //
  // Маркер лежить в `app_state`, а не виводиться з наявних рядків `ai:<день>:%`: прохід, з якого
  // не вийшло жодного рядка (усі спостереження відсіяв дедуп тем або `numbersAreGrounded`), теж
  // коштував грошей, а за старою перевіркою виглядав як «сьогодні ще не рахували» — і наступний
  // виклик у той самий день платив удруге.
  if (await getState(env.DB, AI_LAST_DAY_KEY) === day) return [];

  const { collectFinanceSnapshot } = await import("../ai/advisor.ts");
  const { generateNotifyObservations } = await import("../ai/generate.ts");

  // Теми останніх двох тижнів — і як підказка моделі («не переказуй це знову»), і як фільтр
  // нижче. Промт сам по собі не гарантія (§Правила: інструкція ≠ перевірка), тож обидва шари.
  const recent = await env.DB.prepare(
    `SELECT title, entity_id FROM notifications
     WHERE kind = 'ai' AND created_at >= ? ORDER BY created_at DESC LIMIT 30`,
  ).bind(now - AI_TOPIC_COOLDOWN_DAYS * 86400).all<{ title: string; entity_id: string | null }>();
  const recentRows = recent.results ?? [];
  const seenTopics = new Set(recentRows.map((r) => r.entity_id ?? aiTopicKey(r.title)));

  // ЄДИНЕ джерело контексту — той самий знімок, що бачать Порадник і Чат (§Інваріанти).
  // Не будувати збіднений контекст вручну: саме це колись дало «домислену подушку $780».
  const snap = await collectFinanceSnapshot(env);
  const payload = { ...(snap.context as object), recent_observation_titles: recentRows.map((r) => r.title) };
  const { result } = await generateNotifyObservations(env, payload);
  await setState(env.DB, AI_LAST_DAY_KEY, day);

  // Числа з payload — еталон для перевірки нижче.
  const known = new Set<number>();
  collectNumbers(snap.context, known);

  const out: Draft[] = [];
  for (const o of result.observations ?? []) {
    if (out.length >= 2) break;                    // ліміт на добу — стрічка не має тонути в балачках моделі
    const title = o.title?.trim();
    if (!title) continue;
    // 🔒 Відкидаємо спостереження з сумою, якої в знімку нема (див. `numbersAreGrounded`).
    if (!numbersAreGrounded(`${title} ${o.body ?? ""}`, known)) {
      console.warn("notify/ai: відкинуто спостереження з непідтвердженим числом:", title);
      continue;
    }
    const topic = aiTopicKey(title);
    if (seenTopics.has(topic)) {
      console.warn("notify/ai: тема вже була за останні 14 днів, пропускаю:", title);
      continue;
    }
    seenTopics.add(topic);                         // і в межах однієї відповіді теж
    out.push({
      kind: "ai",
      title: title.slice(0, 120),
      body: (o.body ?? "").trim().slice(0, 400) || null,
      severity: o.severity === "warn" ? "warn" : "info",
      // Тема живе в `entity_id`: без неї дедуп довелося б рахувати із заголовка при кожному
      // читанні, а заголовок ще й обрізається до 120 символів.
      entity_type: "ai_topic", entity_id: topic,
      dedup_key: `ai:${day}:${out.length}`,
    });
  }
  return out;
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
    // Both budget drafters share the `budget` preference: they are one concern seen at two
    // moments (what already happened, and where it is heading), so muting one must mute both.
    ["budget", async () => [...(await draftBudgets(env, now)), ...(await draftBudgetForecast(env, now))]],
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

  const created = await insertDrafts(env, deduped, now, MAX_PER_RUN);

  // Доставка — best-effort і живе в `deliver.ts`: цей файл ВИРІШУЄ, що варто сказати, а не
  // як воно долетить (розділення форсив лінт C3 — див. шапку `deliver.ts`).
  const { deliverPending } = await import("./deliver.ts");
  const delivery = await deliverPending(env);
  const pushed = delivery.telegram + delivery.web;
  skipped.push(...delivery.failed);
  let pruned = 0;
  try { pruned = await pruneNotifications(env, now); }
  catch (e) { skipped.push(`prune: ${e instanceof Error ? e.message : String(e)}`); }

  return { created, pushed, pruned, skipped };
}
