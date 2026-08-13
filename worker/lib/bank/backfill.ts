// Paced statement backfill (§5), provider-driven since 2026-08-13 (BANKS.md §5, step 3).
//
// The loop is a cursor of (account × window) pairs stepped one request at a time, stored in
// `app_state` so it survives an interruption. It is advanced by BOTH the client (immediate
// feedback) and the object's alarm (so it finishes with the tab closed).
//
// What changed: the window length, the gap between requests and the shape of "you are going too
// fast" used to be monobank's constants written here — a 31-day window, 60 seconds, a
// `MonoRateLimit` catch. That made this "monobank's backfill" wearing a general name, and a second
// bank would have had to either fork it or silently break its own limits (which does not fail
// loudly — it just stalls the sync). All three now come from the provider that owns the account.
import type { Env } from "../../env.ts";
import { getState, setState } from "../finance/repo.ts";
import { upsertCanonicalTx } from "../../repo/ingest.ts";
import { bankCredential } from "./credentials.ts";
import { getProvider } from "./providers/index.ts";
import { recordSync } from "../../repo/connections.ts";

export const CURSOR_KEY = "backfill_cursor";
const BACKFILL_DAYS = 90;
/** Used only when a job predates the provider column, i.e. was written by the old code. */
const FALLBACK_GAP_MS = 60_000;

export interface Cursor {
  jobs: { account: string; from: number; to: number; provider?: string }[];
  idx: number;
  total: number;
}

export interface StepResult { done: boolean; progress: number; total: number; retry?: boolean }

/**
 * Builds the cursor over every fetchable account.
 *
 * Grouped by the account's OWN provider, and each provider's window: with two banks a single
 * shared window would either waste requests against the one that allows more, or overshoot the
 * one that allows less.
 */
export async function startBackfill(env: Env): Promise<Cursor> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - BACKFILL_DAYS * 24 * 60 * 60;
  const accounts = await env.DB.prepare(
    "SELECT id, provider FROM accounts WHERE is_manual = 0 AND is_active = 1",
  ).all<{ id: string; provider: string | null }>();

  const jobs: Cursor["jobs"] = [];
  for (const a of accounts.results ?? []) {
    const providerId = a.provider ?? "mono";
    const provider = getProvider(providerId);
    // No fetch capability (a CSV-fed account) or no linked credential: there is nothing to ask,
    // and a job that can never run would sit in the cursor forever pretending to be progress.
    if (!provider?.statement || !bankCredential(env, providerId)) continue;
    const window = provider.statement.pacing.maxWindowSec;
    for (let from = start; from < now; from += window) {
      jobs.push({ account: a.id, provider: providerId, from, to: Math.min(from + window, now) });
    }
  }
  const cursor: Cursor = { jobs, idx: 0, total: jobs.length };
  await setState(env.DB, CURSOR_KEY, JSON.stringify(cursor));
  return cursor;
}

/**
 * Чи лишилась робота по бекфілу. Питає планувальник alarm'ів у `UserDO`.
 *
 * Джерело правди — САМ КУРСОР, а не окремий прапорець: він переживає евікшн і рестарт, і —
 * головне — він уже виставлений у тих, хто був посеред бекфілу, коли планувальник виїхав.
 * Якби «чи є робота» трималось лише на новому полі з таймстампом, їхній прогін мовчки
 * обірвався б на першому ж alarm після деплою.
 */
export async function backfillPending(db: Env["DB"]): Promise<boolean> {
  const raw = await getState(db, CURSOR_KEY);
  if (!raw) return false;
  try {
    const c: Cursor = JSON.parse(raw);
    return c.idx < c.jobs.length;
  } catch {
    return false; // зіпсований курсор — не крутимо alarm вічно
  }
}

/**
 * How long to wait before the NEXT step, according to the bank the next job belongs to.
 *
 * Asked by both pacers — the object's alarm and the client's interval — so neither invents a
 * number. A cursor written before this existed has no provider on its jobs and falls back to
 * monobank's minute, which is exactly what it was being paced at.
 */
export async function nextStepGapMs(env: Env): Promise<number> {
  const raw = await getState(env.DB, CURSOR_KEY);
  if (!raw) return FALLBACK_GAP_MS;
  try {
    const cursor: Cursor = JSON.parse(raw);
    const job = cursor.jobs[cursor.idx];
    const provider = getProvider(job?.provider ?? "mono");
    return provider?.statement?.pacing.minGapMs ?? FALLBACK_GAP_MS;
  } catch {
    return FALLBACK_GAP_MS;
  }
}

/** Виконує рівно один запит виписки і просуває курсор. null = бекфілу немає. */
export async function stepBackfill(env: Env): Promise<StepResult | null> {
  const raw = await getState(env.DB, CURSOR_KEY);
  if (!raw) return null;
  const cursor: Cursor = JSON.parse(raw);

  if (cursor.idx >= cursor.jobs.length) {
    return { done: true, progress: cursor.total, total: cursor.total };
  }

  const job = cursor.jobs[cursor.idx]!;
  // Missing on cursors written before providers existed. Defaulting to mono is what those jobs
  // meant — there was no other bank when they were created.
  const providerId = job.provider ?? "mono";
  const provider = getProvider(providerId);
  const credential = bankCredential(env, providerId);

  if (provider?.statement && credential) {
    // The account's currency is read HERE rather than stored in the cursor: a backfill can span
    // hours, and a cursor built before a stub account was repaired by `syncAccounts` would carry
    // the guess instead of the truth (§STUB-ACC). One tiny query per minute is not a cost.
    const acc = await env.DB.prepare("SELECT currency_code FROM accounts WHERE id = ?")
      .bind(job.account)
      .first<{ currency_code: number | null }>();
    try {
      const txs = await provider.statement.fetch(
        credential, job.account, job.from, job.to, acc?.currency_code ?? 980,
      );
      for (const tx of txs) {
        // Same writer as the webhook, same conflict policy: a statement re-states operations we
        // may already hold, including holds that have since settled (§INGEST-WRITE).
        await upsertCanonicalTx(env.DB, tx, { source: providerId, onConflict: "refresh" });
      }
      await recordSync(env.DB, providerId, provider.label, { ok: true });
    } catch (e) {
      if (provider.statement.isRateLimit(e)) {
        return { done: false, retry: true, progress: cursor.idx, total: cursor.total };
      }
      // The 3 a.m. case this exists for: a token that expired mid-backfill throws into the
      // alarm, which swallows it to keep the chain alive — leaving nothing anywhere a person
      // would look. The connection row is that place (BANKS.md §5, step 4).
      await recordSync(env.DB, providerId, provider.label, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
  // Else: the credential was removed or the provider lost its fetch capability mid-run. The job
  // is skipped rather than retried, because nothing about waiting will make it runnable, and a
  // cursor that cannot advance is an alarm that never stops.

  cursor.idx += 1;
  await setState(env.DB, CURSOR_KEY, JSON.stringify(cursor));
  const done = cursor.idx >= cursor.jobs.length;

  // Наприкінці — раз позначити внутрішні перекази серед підтягнутого.
  if (done) {
    try {
      const { detectTransfers } = await import("../finance/transfers.ts");
      await detectTransfers(env);
    } catch {
      /* best-effort */
    }
  }
  return { done, progress: cursor.idx, total: cursor.total };
}
