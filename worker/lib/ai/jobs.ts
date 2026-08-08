/**
 * §A6 — черга довгих AI-генерацій.
 *
 * Проблема, яку це закриває: порадник/звіт/бюджет-план ідуть 30-60 с і тримали користувача на
 * сторінці. Серверна половина була наполовину готова й раніше — результат пишеться в БД, тож
 * піти зі сторінки роботу не втрачало. Бракувало трьох речей: запустити «не чекаючи»,
 * дізнатись «готово», показати це. Тут — перші дві.
 *
 * Виконання йде НЕ в тілі запиту, а на alarm Durable Object: HTTP-відповідь завершується
 * раніше за роботу, тож `waitUntil` на 60 с — це ставка на те, що ізолят доживе. Постановка
 * задачі = вставити рядок + попросити DO переармувати alarm (`env.scheduleWork`).
 *
 * Чат сюди свідомо НЕ входить: це діалог, його чекають свідомо, і відповідь тостом через дві
 * сторінки читалась би дивно. Масові прогони (ре-світ, батч-enrich) — теж ні: у них інша
 * природа (прогрес у %, а не «готово»).
 */
import type { Env } from "../../env.ts";

export type JobKind = "advisor" | "report" | "budget";
export type JobStatus = "queued" | "running" | "done" | "failed";

export const JOB_KINDS: JobKind[] = ["advisor", "report", "budget"];

export interface JobRow {
  id: number;
  kind: JobKind;
  status: JobStatus;
  params_json: string | null;
  result_json: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  seen_at: number | null;
}

/** Скільки тримаємо завершені задачі. Прибирає добовий крон. */
export const JOB_RETENTION_DAYS = 7;
/** Скільки разів alarm може взятись за задачу, перш ніж визнати її безнадійною. */
const MAX_ATTEMPTS = 3;

/**
 * How long a 'running' row may sit before it counts as abandoned and may be claimed again.
 *
 * 'running' is not a state of the work — it is a TRACE that someone picked the row up. An isolate
 * that dies mid-generation (a demo tab closed while the job runs inside the request, an evicted
 * object, a timeout) leaves the row in that state forever: `runNextJob` selected only 'queued',
 * `hasQueuedJobs` too, and `enqueueJob` reads it as "already in flight" and hands the same dead id
 * back on EVERY later click. One interrupted pass therefore disabled that kind of job for the user
 * permanently, and it looked exactly like a button that does nothing.
 *
 * 3 minutes: the longest real generation (a Sonnet report) is about a minute, so this never steals
 * a live job, and `attempts` still stops a row that keeps dying from spinning forever.
 */
const STALE_RUNNING_SEC = 180;

/** A row worth picking up: never started, or started and abandoned. */
const CLAIMABLE = "(status = 'queued' OR (status = 'running' AND COALESCE(started_at, 0) < ?))";

/**
 * Поставити задачу в чергу.
 *
 * ⚠️ Ідемпотентно за `kind`: якщо для цього виду вже є незавершена задача, повертаємо ЇЇ id.
 * Без цього подвійний клік по «Оновити пораду» = два виклики Sonnet і подвійний рахунок від
 * Anthropic — а користувач бачить рівно той самий результат.
 */
export async function enqueueJob(
  env: Env, kind: JobKind, params?: unknown,
): Promise<{ id: number; created: boolean }> {
  const existing = await env.DB.prepare(
    "SELECT id FROM ai_jobs WHERE kind = ? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1",
  ).bind(kind).first<{ id: number }>();
  if (existing) return { id: existing.id, created: false };

  const now = Math.floor(Date.now() / 1000);
  const ins = await env.DB.prepare(
    "INSERT INTO ai_jobs (kind, status, params_json, created_at) VALUES (?, 'queued', ?, ?)",
  ).bind(kind, params === undefined ? null : JSON.stringify(params), now).run();
  return { id: Number(ins.meta.last_row_id), created: true };
}

/**
 * Останні задачі — і активні, і завершені.
 *
 * Завершені віддаємо СВІДОМО, а не лише «непоказані»: `budget` не має власного сховища, і
 * його результат живе в `result_json` цього рядка. Якби список обмежувався `seen_at IS NULL`,
 * план бюджетів зникав би з екрана в ту ж мить, коли клієнт підтвердив тост.
 * За «показати рівно раз» відповідає `seen_at`, а не склад цієї вибірки; обсяг тримає
 * ретеншн (`pruneJobs`).
 */
export async function listJobs(env: Env): Promise<JobRow[]> {
  const r = await env.DB.prepare("SELECT * FROM ai_jobs ORDER BY id DESC LIMIT 20").all<JobRow>();
  return r.results ?? [];
}

export async function markSeen(env: Env, id: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE ai_jobs SET seen_at = ? WHERE id = ? AND seen_at IS NULL",
  ).bind(Math.floor(Date.now() / 1000), id).run();
}

/**
 * Чи є що виконувати — DO питає це, щоб вирішити, чи взагалі армувати alarm.
 *
 * Бере БД, а не `Env`: планувальник викликає це на кожному армуванні, а зібрати `Env` означає
 * розшифрувати ключі юзера (AES-GCM ×2). Платити за це, щоб порахувати рядки, безглуздо.
 *
 * Вичерпані спроби СВІДОМО лишаються тут «роботою»: саме наступний прохід `runNextJob`
 * переводить такий рядок у 'failed'. Відфільтрувати їх означало б лишити задачу вічно
 * 'queued' — alarm спокійний, зате користувач назавжди бачить «готуємо…».
 */
export async function hasQueuedJobs(db: Env["DB"]): Promise<boolean> {
  const r = await db.prepare(
    `SELECT 1 AS x FROM ai_jobs WHERE ${CLAIMABLE} LIMIT 1`,
  ).bind(Math.floor(Date.now() / 1000) - STALE_RUNNING_SEC).first<{ x: number }>();
  return r != null;
}

/** Ретеншн: завершені задачі старші за тиждень. Викликає добовий крон. */
export async function pruneJobs(env: Env): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - JOB_RETENTION_DAYS * 86400;
  await env.DB.prepare(
    "DELETE FROM ai_jobs WHERE status IN ('done','failed') AND finished_at IS NOT NULL AND finished_at < ?",
  ).bind(cutoff).run();
}

/**
 * Виконати одну задачу. Повертає true, якщо щось узяли в роботу.
 *
 * По одній за прохід свідомо: два Sonnet-виклики підряд в одному alarm — це і довше за будь-який
 * розумний бюджет виконання, і зайвий шанс, що обидва впадуть разом. Якщо в черзі є ще —
 * `hasQueuedJobs` скаже DO переармуватись, і наступна піде своїм проходом.
 */
export async function runNextJob(env: Env): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const job = await env.DB.prepare(
    `SELECT * FROM ai_jobs WHERE ${CLAIMABLE} ORDER BY id LIMIT 1`,
  ).bind(now - STALE_RUNNING_SEC).first<JobRow>();
  if (!job) return false;

  // Лічильник рухаємо ПЕРЕД роботою і в тій самій операції, що й перехід у 'running'. Якщо
  // виконання впаде так, що ми не встигнемо записати 'failed' (обрив ізоляту, помилка самого
  // UPDATE), наступний прохід побачить рядок знову — і на MAX_ATTEMPTS зупинить його сам.
  // Інакше вічно-'queued' рядок тримав би alarm увімкненим назавжди.
  if (job.attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare(
      "UPDATE ai_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
    ).bind("job kept failing before it could report why", now, job.id).run();
    return true;
  }
  await env.DB.prepare(
    "UPDATE ai_jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?",
  ).bind(now, job.id).run();

  try {
    const result = await executeJob(env, job.kind, job.params_json ? JSON.parse(job.params_json) : undefined);
    await env.DB.prepare(
      "UPDATE ai_jobs SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?",
    ).bind(result === undefined ? null : JSON.stringify(result), Math.floor(Date.now() / 1000), job.id).run();
    await announce(env, job.kind, job.id, null, isAuto(job.params_json));
  } catch (e) {
    // §Обробка помилок: справжня причина доходить до користувача. «Спробуй ще раз» замість
    // «ліміт токенів» / «нема ключа» робить збій моделі недіагностованим.
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare(
      "UPDATE ai_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
    ).bind(msg, Math.floor(Date.now() / 1000), job.id).run();
    await announce(env, job.kind, job.id, msg, isAuto(job.params_json));
  }
  return true;
}

/**
 * Чи поставив задачу розклад, а не людина (`params.auto`).
 *
 * Різниця видима: те, що людина натиснула сама, вона й так чекає; те, що прийшло з крону,
 * мусить сказати про себе, ЧОМУ воно тут — інакше «Порада готова» о 12:00 виглядає як подія
 * без причини. Битий JSON тут не подія — тихо вважаємо задачу ручною.
 */
function isAuto(paramsJson: string | null): boolean {
  if (!paramsJson) return false;
  try { return (JSON.parse(paramsJson) as { auto?: unknown }).auto === true; }
  catch { return false; }
}

/**
 * Власне робота. Кожен вид уже має синхронний ендпоінт — тут та сама функція, просто без
 * того, хто на неї чекає.
 *
 * Результат повертають лише ті види, у яких немає власного сховища. `advisor` пише в
 * `app_state.advisor`, `report` — в `ai_reports`; для них клієнт після «готово» просто
 * інвалідує свій тег і бачить свіже. Дублювати їхній результат ще й у рядок задачі означало б
 * два джерела правди для однієї поради.
 */
async function executeJob(env: Env, kind: JobKind, params: unknown): Promise<unknown> {
  if (kind === "advisor") {
    const { buildAdvice } = await import("./advisor.ts");
    await buildAdvice(env);
    return undefined;
  }
  if (kind === "report") {
    const { generateAndStoreReport } = await import("./report.ts");
    const p = (params ?? {}) as { type?: "week" | "month" | "custom"; scope?: "last" | "current"; range?: { from: number; to: number } };
    await generateAndStoreReport(env, p.type ?? "week", { force: true, scope: p.scope ?? "last", range: p.range });
    return undefined;
  }
  const { proposeBudgets } = await import("./advisor.ts");
  return await proposeBudgets(env); // єдиний вид без власного сховища — результат живе в рядку
}

/**
 * Рядок у стрічку сповіщень.
 *
 * Це половина «закритої вкладки»: тост побачить лише той, хто повернувся до застосунку, а
 * стрічка лишається слідом для всіх інших випадків. Best-effort — не даємо їй завалити
 * задачу, яка насправді відпрацювала.
 */
async function announce(env: Env, kind: JobKind, jobId: number, error: string | null, auto = false): Promise<void> {
  try {
    const { pushJobNotification } = await import("../messaging/notify.ts");
    await pushJobNotification(env, kind, jobId, error, auto);
  } catch {
    /* стрічка не критична для самої генерації */
  }
}
