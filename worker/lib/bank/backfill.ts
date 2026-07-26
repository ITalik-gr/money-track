// Пейсований бекфіл виписки (§5). Mono statement: вікно ≤ 31 доба 1 год, ≤ 500
// записів (найновіші), ліміт 1 запит/60с на токен. Тому йдемо курсором пар
// (рахунок × місячне вікно), по одному запиту. Курсор у app_state — переживає
// перерву. Крок викликається і клієнтом (миттєвий фідбек), і хвилинним кроном
// (щоб довести до кінця навіть із закритою вкладкою).
import type { Env } from "../../env.ts";
import { getStatement, MonoRateLimit } from "./mono.ts";
import { getState, setState, upsertMonoTx } from "../finance/repo.ts";

export const CURSOR_KEY = "backfill_cursor";
const BACKFILL_DAYS = 90;
const WINDOW = 31 * 24 * 60 * 60 - 3600; // ≤ 31 доба 1 год (ліміт mono), із запасом

export interface Cursor {
  jobs: { account: string; from: number; to: number }[];
  idx: number;
  total: number;
}

export interface StepResult { done: boolean; progress: number; total: number; retry?: boolean }

export async function startBackfill(env: Env): Promise<Cursor> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - BACKFILL_DAYS * 24 * 60 * 60;
  const accounts = await env.DB.prepare(
    "SELECT id FROM accounts WHERE is_manual = 0 AND is_active = 1",
  ).all<{ id: string }>();

  const jobs: Cursor["jobs"] = [];
  for (const a of accounts.results ?? []) {
    for (let from = start; from < now; from += WINDOW) {
      jobs.push({ account: a.id, from, to: Math.min(from + WINDOW, now) });
    }
  }
  const cursor: Cursor = { jobs, idx: 0, total: jobs.length };
  await setState(env.DB, CURSOR_KEY, JSON.stringify(cursor));
  return cursor;
}

// Виконує рівно один запит виписки і просуває курсор. null = бекфілу немає.
export async function stepBackfill(env: Env): Promise<StepResult | null> {
  const raw = await getState(env.DB, CURSOR_KEY);
  if (!raw) return null;
  const cursor: Cursor = JSON.parse(raw);

  if (cursor.idx >= cursor.jobs.length) {
    return { done: true, progress: cursor.total, total: cursor.total };
  }

  const job = cursor.jobs[cursor.idx];
  try {
    const items = await getStatement(env.MONO_TOKEN, job.account, job.from, job.to);
    for (const item of items) await upsertMonoTx(env.DB, job.account, item);
  } catch (e) {
    if (e instanceof MonoRateLimit) {
      return { done: false, retry: true, progress: cursor.idx, total: cursor.total };
    }
    throw e;
  }

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
