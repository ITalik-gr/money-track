// Knowledge-corpus documents. See `worker/repo/README.md`.
//
// Three kinds share one table: `user` (a note the user wrote), `override` (their edit of a
// built-in doc, stored ALONGSIDE the shipped text rather than replacing it — deleting the row
// restores the factory version), and the built-ins themselves, which live in code and never
// reach this table unless overridden.
import type { AppDb } from "../lib/platform/db-shim.ts";

export async function createUserDoc(
  db: AppDb, id: string, title: string, summary: string, body: string, at: number,
): Promise<void> {
  await db.prepare(
    "INSERT INTO knowledge_docs (id, kind, title, summary, body, enabled, created_at, updated_at) VALUES (?, 'user', ?, ?, ?, 1, ?, ?)",
  ).bind(id, title, summary, body, at, at).run();
}

/** Insert or update in one statement: an override may or may not already exist for a built-in. */
export async function upsert(
  db: AppDb, id: string, kind: string, title: string, summary: string,
  body: string, enabled: number, at: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO knowledge_docs (id, kind, title, summary, body, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, summary = excluded.summary,
       body = excluded.body, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).bind(id, kind, title, summary, body, enabled, at, at).run();
}

/** Removes a user note outright; for a built-in it drops the override and the shipped text returns. */
export async function remove(db: AppDb, id: string): Promise<void> {
  await db.prepare("DELETE FROM knowledge_docs WHERE id = ?").bind(id).run();
}
