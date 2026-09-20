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

/**
 * A job that runs in ONE pass. Each already has a synchronous endpoint; the queue just removes
 * the person waiting on it.
 */
export type SingleJobKind = "advisor" | "report" | "budget";

/**
 * A job that runs in MANY passes, one batch per alarm tick, reporting progress in between.
 *
 * `noop_batch` is deliberately the only member for now, and it is not real work: it counts. The
 * mechanism below is a loop over an alarm that re-arms itself, and the failure mode of a wrong
 * stop condition is an object that spins forever and burns money on a model. So the loop is built
 * and pinned against a payload that costs nothing, and only then will the paying kinds
 * (re-sweep, batch enrich) be hung on it — with the owner watching, not overnight (`ROADMAP.md`).
 */
export type BatchJobKind = "noop_batch";

export type JobKind = SingleJobKind | BatchJobKind;
export type JobStatus = "queued" | "running" | "done" | "failed";

/**
 * The kinds the API will enqueue on request.
 *
 * `noop_batch` is NOT here, and that is the point: a test fixture that a client could start is a
 * way to spend alarm ticks on nothing. The batch kinds stay unreachable from outside until a real
 * one exists.
 */
export const JOB_KINDS: SingleJobKind[] = ["advisor", "report", "budget"];

const BATCH_KINDS: BatchJobKind[] = ["noop_batch"];
const isBatch = (kind: string): kind is BatchJobKind => (BATCH_KINDS as string[]).includes(kind);

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
  /** Both NULL for a single-pass job — the absence of a denominator IS how the two are told apart. */
  progress_done: number | null;
  progress_total: number | null;
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

  if (isBatch(job.kind)) {
    await runBatchTick(env, job);
    return true;
  }

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
 * ONE batch of a mass run, and the decision of whether there is to be another.
 *
 * ⚠️ THIS IS A LOOP OVER AN ALARM, and that is the whole reason it was built this way. The tick
 * leaves the row 'queued' rather than 'running', `hasQueuedJobs` therefore sees work, `armAlarm`
 * re-arms, and the next alarm takes the next batch. Nothing in the scheduler had to change — but
 * it does mean a wrong stop condition is not a stuck job, it is an object that wakes itself
 * forever, and for a real kind each of those wake-ups would be a paid model call.
 *
 * So the stop condition is not «the executor says it is finished». It is **`progress_done` must
 * strictly increase**: a batch that moved nothing ends the job as failed, whatever it claims. An
 * executor that returns the same cursor twice — an empty page, an off-by-one, a query that stops
 * matching — is exactly the bug that would otherwise spin, and it is the one case a test cannot
 * enumerate in advance. `total <= 0` finishes immediately for the same reason: there is no batch
 * that could make progress against it.
 *
 * `attempts` is reset by a tick that moved: for a single job it counts pickups, and a mass run
 * has many legitimate ones. What it still bounds is CONSECUTIVE failures, which is what it was
 * there to bound.
 */
async function runBatchTick(env: Env, job: JobRow): Promise<void> {
  const before = job.progress_done ?? 0;
  const finish = async (status: "done" | "failed", error: string | null, done: number, total: number) => {
    await env.DB.prepare(
      "UPDATE ai_jobs SET status = ?, error = ?, progress_done = ?, progress_total = ?, finished_at = ? WHERE id = ?",
    ).bind(status, error, done, total, Math.floor(Date.now() / 1000), job.id).run();
  };

  let tick: BatchTick;
  try {
    tick = await executeBatch(env, job.kind as BatchJobKind, job.params_json ? JSON.parse(job.params_json) : undefined, before);
  } catch (e) {
    // §Обробка помилок — the real cause, same as the single-pass path. A mass run that stops
    // needs to say which batch stopped it, and `progress_done` is left where it actually got to.
    await finish("failed", e instanceof Error ? e.message : String(e), before, job.progress_total ?? 0);
    return;
  }

  const total = Math.max(0, Math.trunc(tick.total));
  const done = Math.max(0, Math.trunc(tick.done));
  if (total <= 0) return void await finish("done", null, 0, 0);
  if (done >= total) return void await finish("done", null, Math.min(done, total), total);
  if (done <= before) {
    return void await finish("failed", `batch made no progress at ${before}/${total}`, before, total);
  }

  // Back to 'queued': claimable on the very next pass, which is what keeps the run moving without
  // waiting out `STALE_RUNNING_SEC`. `attempts = 0` because this pickup succeeded.
  await env.DB.prepare(
    "UPDATE ai_jobs SET status = 'queued', attempts = 0, progress_done = ?, progress_total = ? WHERE id = ?",
  ).bind(done, total, job.id).run();
}

/** What one batch reports: where the run has got to, and how far it has to go. */
export interface BatchTick { done: number; total: number }

/**
 * The batch executors.
 *
 * `noop_batch` counts and nothing else — `{total, size}` in, `size` more done each tick. It is a
 * fixture, and it earns its place by being the only way to test the LOOP without paying for the
 * payload: the real kinds (re-sweep, batch enrich) cannot be run in a test at all, because
 * without a live key their payload never executes.
 */
async function executeBatch(
  _env: Env, kind: BatchJobKind, params: unknown, done: number,
): Promise<BatchTick> {
  if (kind === "noop_batch") {
    const p = (params ?? {}) as { total?: number; size?: number; stall?: boolean };
    const total = Math.max(0, Math.trunc(p.total ?? 0));
    const size = Math.max(1, Math.trunc(p.size ?? 1));
    // `stall` exists so the STOP CONDITION can be tested, not the happy path: it reproduces the
    // executor that keeps answering with the same cursor, which is the shape of every bug that
    // would otherwise spin the alarm forever. A fixture with no way to fail tests nothing.
    return { done: p.stall ? done : Math.min(done + size, total), total };
  }
  // Unreachable while `noop_batch` is the only member — and a compile error the moment it is not,
  // which is the point: a new batch kind must arrive with its executor, not with a silent default.
  throw new Error(`no batch executor for ${kind satisfies never}`);
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
  const { proposeBudgets } = await import("./budget.ts");
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
  // A batch kind says nothing yet: `noop_batch` has nothing to announce, and a REAL mass run
  // arrives with its own `NotifKind`, preference and template (CLAUDE.md) rather than borrowing
  // the one-shot generation's sentence.
  if (isBatch(kind)) return;
  try {
    const { pushJobNotification } = await import("../messaging/notify.ts");
    await pushJobNotification(env, kind, jobId, error, auto);
  } catch {
    /* стрічка не критична для самої генерації */
  }
}
