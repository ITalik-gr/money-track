// §MEMORY — the only place that reads or writes `agent_memory`.
import type { AppDb } from "../lib/platform/db-shim.ts";
import type { MemoryArchiveReason, MemoryHorizon, MemoryItem, MemoryKind } from "../../shared/api/memory.ts";

export interface NewMemory {
  topic: string; text: string; kind: MemoryKind; horizon: MemoryHorizon; importance: number;
  pinned: number; source: "chat" | "user"; valid_until: number | null; review_at: number; at: number;
}

export async function listActive(db: AppDb): Promise<MemoryItem[]> {
  const r = await db.prepare(
    "SELECT * FROM agent_memory WHERE status = 'active' ORDER BY pinned DESC, importance DESC, confirmed_at DESC, id DESC",
  ).all<MemoryItem>();
  return r.results ?? [];
}

export async function listArchived(db: AppDb, limit: number): Promise<MemoryItem[]> {
  const r = await db.prepare(
    "SELECT * FROM agent_memory WHERE status = 'archived' ORDER BY updated_at DESC, id DESC LIMIT ?",
  ).bind(limit).all<MemoryItem>();
  return r.results ?? [];
}

export async function byId(db: AppDb, id: number): Promise<MemoryItem | null> {
  return await db.prepare("SELECT * FROM agent_memory WHERE id = ?").bind(id).first<MemoryItem>();
}

export async function insert(db: AppDb, m: NewMemory): Promise<number> {
  const row = await db.prepare(
    `INSERT INTO agent_memory (topic, text, kind, horizon, importance, pinned, source, valid_until, review_at, confirmed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(m.topic, m.text, m.kind, m.horizon, m.importance, m.pinned, m.source, m.valid_until, m.review_at, m.at, m.at, m.at)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

export async function archive(db: AppDb, id: number, reason: MemoryArchiveReason, at: number): Promise<void> {
  await db.prepare("UPDATE agent_memory SET status = 'archived', archive_reason = ?, updated_at = ? WHERE id = ?")
    .bind(reason, at, id).run();
}

export async function linkReplacement(db: AppDb, id: number, replacedBy: number): Promise<void> {
  await db.prepare("UPDATE agent_memory SET replaced_by = ? WHERE id = ?").bind(replacedBy, id).run();
}

export async function confirm(db: AppDb, id: number, reviewAt: number, at: number): Promise<void> {
  await db.prepare("UPDATE agent_memory SET confirmed_at = ?, review_at = ?, updated_at = ? WHERE id = ?")
    .bind(at, reviewAt, at, id).run();
}

export async function setPinned(db: AppDb, id: number, pinned: boolean, at: number): Promise<void> {
  await db.prepare("UPDATE agent_memory SET pinned = ?, updated_at = ? WHERE id = ?").bind(pinned ? 1 : 0, at, id).run();
}

export async function setText(db: AppDb, id: number, text: string, reviewAt: number, at: number): Promise<void> {
  await db.prepare("UPDATE agent_memory SET text = ?, source = 'user', confirmed_at = ?, review_at = ?, updated_at = ? WHERE id = ?")
    .bind(text, at, reviewAt, at, id).run();
}

export async function restore(db: AppDb, id: number, reviewAt: number, at: number): Promise<void> {
  await db.prepare(
    `UPDATE agent_memory SET status = 'active', archive_reason = NULL, replaced_by = NULL, valid_until = NULL,
       confirmed_at = ?, review_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(at, reviewAt, at, id).run();
}

export async function remove(db: AppDb, id: number): Promise<void> {
  await db.prepare("DELETE FROM agent_memory WHERE id = ?").bind(id).run();
}

/** Archived rows are history, kept so a wrong auto-archive can be undone, and not forever. */
export async function purgeArchived(db: AppDb, before: number): Promise<void> {
  await db.prepare("DELETE FROM agent_memory WHERE status = 'archived' AND updated_at < ?").bind(before).run();
}
