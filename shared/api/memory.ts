// Response shapes of `/api/memory/*` — the assistant's long-term memory (§MEMORY).

export type MemoryKind = "identity" | "work" | "housing" | "obligation" | "goal" | "plan" | "preference" | "context";
export type MemoryHorizon = "lasting" | "months" | "weeks" | "days";

export type MemoryArchiveReason = "expired" | "stale" | "replaced" | "resolved" | "user" | "cap";

export interface MemoryItem {
  id: number;
  topic: string;
  text: string;
  kind: MemoryKind;
  horizon: MemoryHorizon;
  importance: number;
  status: "active" | "archived";
  archive_reason: MemoryArchiveReason | null;
  replaced_by: number | null;
  pinned: number;
  source: "chat" | "user";
  valid_until: number | null;
  review_at: number;
  confirmed_at: number;
  created_at: number;
  updated_at: number;
}

export interface MemoryList {
  active: MemoryItem[];
  archived: MemoryItem[];
}
