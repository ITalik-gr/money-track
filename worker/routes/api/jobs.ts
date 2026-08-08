// `/jobs/*`, `/enrich/*` and `/ai-usage` — background AI work and what it costs.
//
// Queueing is idempotent PER KIND: a double click on "refresh the advice" must not buy two
// Sonnet calls for one answer on screen. The queue is drained by the Durable Object alarm,
// which is a SCHEDULER — only `armAlarm` sets it (§A6).
import * as txRepo from "../../repo/transactions.ts";
import { st } from "../../lib/platform/i18n.ts";
import { apiRoutes } from "./_shared.ts";
import type { AiJob } from "../../../shared/api/ai.ts";
import type { AiUsageStats } from "../../../shared/types.ts";

export const jobs = apiRoutes();

// §Хвіст C: глобальний лічильник витрат AI — «$ за сьогодні / цей місяць / за весь час».
jobs.get("/ai-usage", async (c) => {
  const { readUsageStats } = await import("../../lib/ai/cost.ts");
  return c.json(await readUsageStats(c.env) satisfies AiUsageStats);
});

// ---- §A6: фонові AI-генерації -----------------------------------------------
//
// Клієнт ставить задачу й одразу отримує id — робота йде на alarm об'єкта, тож піти зі
// сторінки (і навіть закрити вкладку) її не скасовує. Поллінг лише поки щось активне.

jobs.post("/jobs", async (c) => {
  const locale = c.get("locale");
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(locale, "errAiKeyMissing"), code: "no_ai_key" }, 400);

  const body = await c.req.json<{ kind?: string; params?: unknown }>().catch(() => ({} as { kind?: string; params?: unknown }));
  const { JOB_KINDS, enqueueJob, runNextJob } = await import("../../lib/ai/jobs.ts");
  const kind = JOB_KINDS.find((k) => k === body.kind);
  if (!kind) return c.json({ error: st(locale, "jobBadKind") }, 400);

  const { id, created } = await enqueueJob(c.env, kind, body.params);

  const { isDemoEnv } = await import("../../lib/platform/demo.ts");
  if (isDemoEnv(c.env)) {
    // A demo runs the job inline: `demoClamp` caps the output at 900 tokens, so the wait is short.
    // The client never notices the difference — it sees the job through `GET /jobs` either way,
    // just already finished.
    //
    // ⚠️ Drain the queue ALWAYS, not only when `created` — that gate is what made the demo "only
    // start on the second try". An interrupted first request (navigated away, backgrounded tab)
    // leaves the row unfinished, and `enqueueJob` correctly returns its id instead of a new one.
    // Behind `if (created)` nobody was left to execute that row: the sandbox's single alarm is
    // busy with its own self-destruct and never touches the queue, so every later click landed in
    // the same "already exists, do nothing" branch and the work never happened.
    await runNextJob(c.env);
  } else {
    await c.env.scheduleWork?.();
  }
  return c.json({ job_id: id, created });
});

jobs.get("/jobs", async (c) => {
  const { listJobs } = await import("../../lib/ai/jobs.ts");
  return c.json({ items: await listJobs(c.env) satisfies AiJob[] });
});

// Клієнт підтверджує, що показав тост. Без цього «завершені й не показані» показувались би
// щоразу при вході — або губились би зовсім у того, хто закрив вкладку.
jobs.post("/jobs/:id/seen", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const { markSeen } = await import("../../lib/ai/jobs.ts");
  await markSeen(c.env, id);
  return c.json({ ok: true });
});

// Bulk-enrich uncategorised transactions, a small batch per call (client loops).
jobs.post("/enrich/pending", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: st(c.get("locale"), "errAiKeyMissing"), code: "no_ai_key" }, 400);
  const { enrichPending } = await import("../../lib/ai/enrich.ts");
  try {
    return c.json(await enrichPending(c.env));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

jobs.get("/enrich/status", async (c) => {
  return c.json({ pending: await txRepo.pendingEnrichCount(c.env.DB) });
});
