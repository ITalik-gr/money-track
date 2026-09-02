/**
 * §2 — the adviser's own log: a compact snapshot per generated advice, so the trajectory of the
 * recommendations is visible and not just the newest one.
 *
 * Split out of `advisor.ts` on 2026-09-02 under lint C3, and the seam is a real one: everything
 * left there ANSWERS the question "how is the user doing" out of one snapshot, while this file
 * only stores and trims what those answers said. The import runs one way — `advisor.ts` calls
 * `pushAdviceHistory` and this file calls nothing back.
 *
 * The store is a JSON array in `app_state`, not a table: it is capped, read whole and never
 * joined. That makes `generated_at` the only identity an entry has, which is why deletion is
 * addressed by it (an index would shift under a concurrent delete from another device).
 */
import type { Env } from "../../env.ts";
import type { AdviceHistoryItem } from "../../../shared/api/ai.ts";
import { getState, setState } from "../finance/repo.ts";

const KEY = "advisor_history";
const CAP = 24;

export type { AdviceHistoryItem };

export async function getAdviceHistory(env: Env): Promise<AdviceHistoryItem[]> {
  const raw = await getState(env.DB, KEY);
  return raw ? (JSON.parse(raw) as AdviceHistoryItem[]) : [];
}

export async function clearAdviceHistory(env: Env): Promise<void> {
  await setState(env.DB, KEY, JSON.stringify([]));
}

/**
 * Drop ONE snapshot, addressed by the second it was generated at.
 *
 * Deleting an entry that is no longer there is a no-op, not an error: the reader's intent is
 * "make this gone", and it is gone.
 */
export async function deleteAdviceHistoryEntry(env: Env, at: number): Promise<number> {
  const hist = await getAdviceHistory(env);
  const left = hist.filter((h) => h.generated_at !== at);
  if (left.length !== hist.length) await setState(env.DB, KEY, JSON.stringify(left));
  return left.length;
}

/**
 * Record one snapshot. Best-effort by design: a log that can fail the generation it describes
 * would make the app worse at the thing it was actually asked to do.
 */
export async function pushAdviceHistory(env: Env, item: AdviceHistoryItem): Promise<void> {
  try {
    const hist = await getAdviceHistory(env);
    hist.unshift(item);
    await setState(env.DB, KEY, JSON.stringify(hist.slice(0, CAP)));
  } catch { /* історія не критична */ }
}
