// Savings-goal reads and writes (§P2.1). See `worker/repo/README.md`.
import type { AppDb } from "../lib/platform/db-shim.ts";
import type { SavingsGoal } from "../../shared/api/planning.ts";
import type { GoalContribution } from "../../shared/api/planning.ts";

/**
 * A goal row plus the joined jar columns — `SELECT g.*`, so every stored column is present.
 *
 * `current` is NOT here: it is computed by the route (jar balance when linked, manual amount
 * otherwise), which is why this is `SavingsGoal` minus that one field rather than a twin.
 */
export type GoalRow = Omit<SavingsGoal, "current">;

/** Active goals with their linked jar's balance joined in, newest first. */
export async function listActive(db: AppDb): Promise<GoalRow[]> {
  const r = await db.prepare(
    `SELECT g.*, a.balance AS account_balance, a.title AS account_title
     FROM savings_goals g
     LEFT JOIN accounts a ON a.id = g.account_id
     WHERE g.is_active = 1 ORDER BY g.created_at DESC`,
  ).all<GoalRow>();
  return r.results ?? [];
}

export interface NewGoal {
  name: string;
  target_amount: number;
  current_amount: number;
  account_id: string | null;
  deadline: number | null;
  color: string;
  note: string | null;
  kind: string;
  autofill_kind: string | null;
  autofill_value: number | null;
  created_at: number;
}

export async function create(db: AppDb, g: NewGoal): Promise<number> {
  const r = await db.prepare(
    `INSERT INTO savings_goals (name, target_amount, current_amount, account_id, deadline, color, note, kind, autofill_kind, autofill_value, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).bind(g.name, g.target_amount, g.current_amount, g.account_id, g.deadline,
    g.color, g.note, g.kind, g.autofill_kind, g.autofill_value, g.created_at).run();
  return r.meta.last_row_id;
}

/**
 * Partial update.
 *
 * `undefined` means "leave alone" and `null` means "clear" — they are genuinely different here
 * (a goal with no deadline is not a goal whose deadline we are not touching), so the caller
 * passes only the keys it means to change.
 */
export interface GoalPatch {
  name?: string;
  target_amount?: number;
  current_amount?: number;
  account_id?: string | null;
  deadline?: number | null;
  color?: string;
  note?: string | null;
  kind?: string;
  /** Setting this ALSO resets `autofill_last_ym`; see below. */
  autofill?: { kind: string | null; value: number | null };
}

const SIMPLE_COLUMNS = ["name", "target_amount", "current_amount", "account_id",
  "deadline", "color", "note", "kind"] as const;

/** @returns false when the patch was empty, so the caller can skip the write. */
export async function update(db: AppDb, id: number, patch: GoalPatch): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];

  for (const col of SIMPLE_COLUMNS) {
    const v = patch[col];
    if (v !== undefined) { sets.push(`${col} = ?`); binds.push(v); }
  }
  if (patch.autofill !== undefined) {
    // Turning the rule off clears the month stamp too: otherwise re-enabling it within the same
    // month would credit nothing, and the rule would look enabled while being dead.
    sets.push("autofill_kind = ?", "autofill_value = ?", "autofill_last_ym = NULL");
    binds.push(patch.autofill.kind, patch.autofill.value);
  }
  if (!sets.length) return false;

  await db.prepare(`UPDATE savings_goals SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  return true;
}

/** Soft delete — the contribution history stays readable. */
export async function archive(db: AppDb, id: number): Promise<void> {
  await db.prepare("UPDATE savings_goals SET is_active = 0 WHERE id = ?").bind(id).run();
}

// ---- contributions ----------------------------------------------------------
//
// `savings_goals.current_amount` is a denormalised SUM of these rows, and its ONLY writer is
// `recalcGoal` (`lib/finance/goals.ts`). Callers here write a contribution and then ask
// `recalcGoal` for the new total; they never touch `current_amount` themselves.

export async function listContributions(db: AppDb, goalId: number): Promise<GoalContribution[]> {
  const r = await db.prepare(
    "SELECT id, amount, at, note, source FROM goal_contributions WHERE goal_id = ? ORDER BY at DESC, id DESC LIMIT 100",
  ).bind(goalId).all<GoalContribution>();
  return r.results ?? [];
}

/** Identity and jar linkage only — enough to decide whether a contribution is allowed. */
export async function findActive(db: AppDb, id: number): Promise<{ id: number; account_id: string | null } | null> {
  return await db.prepare("SELECT id, account_id FROM savings_goals WHERE id = ? AND is_active = 1")
    .bind(id).first<{ id: number; account_id: string | null }>();
}

export async function addContribution(
  db: AppDb, goalId: number, amount: number, at: number, note: string | null,
): Promise<void> {
  await db.prepare(
    "INSERT INTO goal_contributions (goal_id, amount, at, note, source) VALUES (?, ?, ?, ?, 'manual')",
  ).bind(goalId, amount, at, note).run();
}

/** Scoped by `goal_id` as well as `id`: an id alone would let one goal delete another's row. */
export async function deleteContribution(db: AppDb, goalId: number, contributionId: number): Promise<void> {
  await db.prepare("DELETE FROM goal_contributions WHERE id = ? AND goal_id = ?")
    .bind(contributionId, goalId).run();
}
