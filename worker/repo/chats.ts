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

/**
 * The advisor's rail — `kind='advisor'` ONLY (§TX-CHAT, migration 0040).
 *
 * A conversation about one coffee is a real conversation and is stored in the same table, but it
 * does not belong in the list of financial conversations: mixing them would bury the four the user
 * actually returns to under every operation they ever asked about.
 */
export async function listChats(db: AppDb): Promise<ChatSummary[]> {
  const r = await db.prepare(
    `SELECT c.id AS id, c.title AS title, c.updated_at AS updated_at,
            (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id) AS message_count
       FROM chats c WHERE c.kind = 'advisor' ORDER BY c.updated_at DESC`,
  ).all<ChatSummary>();
  return r.results ?? [];
}

/**
 * §TX-CHAT — the conversation about one transaction, addressed by WHAT IT IS ABOUT.
 *
 * The id is derived, not remembered: the page knows the transaction, so it must be able to find
 * the conversation without storing a second key anywhere. Prefixed rather than reusing the raw
 * transaction id so a `tx` row can never collide with a client-generated advisor id (`c<base36>`).
 */
export const txChatId = (txId: string) => `tx-${txId}`;

export async function txMessages(db: AppDb, txId: string): Promise<ChatTurn[]> {
  return await messages(db, txChatId(txId));
}

/**
 * Append one exchange about a transaction, creating the conversation on first use.
 *
 * Written by the SERVER, both halves, in the same place the answer is produced — the §CHAT-SYNC
 * rule. The client posting its own turn and the server posting the reply would leave a
 * half-recorded exchange whenever the generation failed.
 */
export async function appendTxTurn(
  db: AppDb, txId: string, title: string, question: string, answer: string, at: number,
): Promise<void> {
  const id = txChatId(txId);
  await db.prepare(
    "INSERT OR IGNORE INTO chats (id, title, created_at, updated_at, kind, entity_id) VALUES (?, ?, ?, ?, 'tx', ?)",
  ).bind(id, title.slice(0, 80), at, at, txId).run();
  await pruneChats(db, "tx");
  await append(db, id, "user", question, at);
  await append(db, id, "assistant", answer, at);
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

/**
 * Oldest conversations beyond the ceiling. Never touches the one just written (it is newest).
 *
 * ⚠️ The ceiling is PER KIND (§TX-CHAT). A single shared limit would let the two compete: asking
 * about sixty individual operations would silently evict every advisor conversation, and the user
 * would find their financial discussions gone without ever deleting one. They are different
 * things with different lifespans, so they get separate budgets.
 */
async function pruneChats(db: AppDb, kind = "advisor"): Promise<void> {
  await db.prepare(
    `DELETE FROM chats WHERE kind = ? AND id NOT IN (
       SELECT id FROM chats WHERE kind = ? ORDER BY updated_at DESC LIMIT ?)`,
  ).bind(kind, kind, MAX_CHATS).run();
}
