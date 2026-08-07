// Adviser conversations — the only place that reads or writes `chats` / `chat_messages`.
// See `worker/repo/README.md`, and `migrations/0038_chats.sql` for why they are server-side.
import type { AppDb } from "../lib/platform/db-shim.ts";
import type { ChatSummary, ChatTurn } from "../../shared/api/chats.ts";

/**
 * Retention. Both ceilings exist because this table grows from the one action a user repeats
 * without thinking — asking another question — and nothing else here ever deletes a row.
 *
 * They are enforced on WRITE rather than by a nightly sweep: a sweep is another scheduled job
 * that can silently stop running, and the only moment the numbers can actually be exceeded is
 * the moment something was appended.
 */
const MAX_CHATS = 60;
const MAX_MESSAGES_PER_CHAT = 200;

export async function listChats(db: AppDb): Promise<ChatSummary[]> {
  const r = await db.prepare(
    `SELECT c.id AS id, c.title AS title, c.updated_at AS updated_at,
            (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id) AS message_count
       FROM chats c ORDER BY c.updated_at DESC`,
  ).all<ChatSummary>();
  return r.results ?? [];
}

export async function messages(db: AppDb, chatId: string): Promise<ChatTurn[]> {
  const r = await db.prepare(
    "SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY id",
  ).bind(chatId).all<ChatTurn>();
  return r.results ?? [];
}

export async function exists(db: AppDb, chatId: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS x FROM chats WHERE id = ?").bind(chatId).first());
}

/**
 * Create if absent. `OR IGNORE` and not an upsert: the client creates the row on its first send,
 * and a retry of that same send (a flaky connection, a double tap) must not blank a title or a
 * timestamp that the other device has meanwhile moved on.
 */
export async function create(db: AppDb, id: string, title: string, at: number): Promise<void> {
  await db.prepare(
    "INSERT OR IGNORE INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).bind(id, title, at, at).run();
  await pruneChats(db);
}

export async function rename(db: AppDb, id: string, title: string): Promise<void> {
  await db.prepare("UPDATE chats SET title = ? WHERE id = ?").bind(title, id).run();
}

/** The messages go with it via `ON DELETE CASCADE` (FKs are on inside the DO). */
export async function remove(db: AppDb, id: string): Promise<void> {
  await db.prepare("DELETE FROM chats WHERE id = ?").bind(id).run();
}

export async function append(
  db: AppDb, chatId: string, role: "user" | "assistant", content: string, at: number,
): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .bind(chatId, role, content, at),
    // `MAX` and not a plain assignment: the two devices' clocks are not the same clock, and a
    // reply written by the server while an older device syncs must never move the rail backwards.
    db.prepare("UPDATE chats SET updated_at = MAX(updated_at, ?) WHERE id = ?").bind(at, chatId),
  ]);
  await db.prepare(
    `DELETE FROM chat_messages WHERE chat_id = ? AND id NOT IN (
       SELECT id FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?)`,
  ).bind(chatId, chatId, MAX_MESSAGES_PER_CHAT).run();
}

/**
 * Drop everything after the first `keep` turns — what "regenerate" does.
 *
 * Server-side rather than "delete this id": the client asks in terms of the transcript it is
 * looking at, and a message id it guessed from a stale copy would delete the wrong turn.
 */
export async function truncate(db: AppDb, chatId: string, keep: number): Promise<void> {
  await db.prepare(
    `DELETE FROM chat_messages WHERE chat_id = ? AND id NOT IN (
       SELECT id FROM chat_messages WHERE chat_id = ? ORDER BY id LIMIT ?)`,
  ).bind(chatId, chatId, Math.max(0, keep)).run();
}

/** Oldest conversations beyond the ceiling. Never touches the one just written (it is newest). */
async function pruneChats(db: AppDb): Promise<void> {
  await db.prepare(
    `DELETE FROM chats WHERE id NOT IN (
       SELECT id FROM chats ORDER BY updated_at DESC LIMIT ?)`,
  ).bind(MAX_CHATS).run();
}
