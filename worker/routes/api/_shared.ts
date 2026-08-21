// Plumbing shared by every module under `routes/api/`.
//
// Each domain file builds its own Hono instance and `index.ts` mounts them all on one parent.
// The parent owns the locale middleware, so `c.get("locale")` is available everywhere without
// each module repeating the lookup — which is also why the Variables type lives here rather than
// being re-declared per file: two spellings of it would compile, and the second one to drift
// would only be noticed when a category name came back in the wrong language.
import { Hono } from "hono";
import type { Env } from "../../env.ts";
import type { NotifLocale } from "../../../shared/notif-i18n.ts";

export type ApiEnv = { Bindings: Env; Variables: { locale: NotifLocale } };

/** A sub-app with the parent's bindings and variables already in its type. */
export const apiRoutes = () => new Hono<ApiEnv>();

// Chat history sanitiser, shared by all four chat endpoints (advisor / tx / group / budget).
//
// The per-message LENGTH cap is the point: the AI spend guards count CALLS, and one call with a
// pasted novel in it costs as much as a hundred normal ones. 12 turns is what the client sends;
// 8k characters is far above any real message and far below anything that hurts. Written once
// because four copy-pasted parsers is how one of them ends up without the cap.
const CHAT_MAX_TURNS = 12;
const CHAT_MAX_CHARS = 8000;
export type ChatTurn = { role: "user" | "assistant"; content: string };
export function normChatMessages(raw: unknown): ChatTurn[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((m): m is ChatTurn =>
      !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim() !== "")
    .slice(-CHAT_MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, CHAT_MAX_CHARS) }));
}

/**
 * A numeric query parameter, or the fallback — never `NaN`.
 *
 * Written 2026-08-21 after a security-shaped pass over the night's new endpoints found two of them
 * returning **500 on garbage input**: `?months=abc`. The idiom everywhere is
 * `Number(url.searchParams.get(x) ?? d)`, and `??` does not catch `NaN` — `Number("abc")` is a
 * value, so the fallback never fires and the NaN travels into date arithmetic, where it becomes an
 * exception several layers down. The quieter variant is worse: a NaN window binds cleanly and the
 * endpoint answers `{from: null, spend: 0}`, which reads as «нічого не витрачено».
 *
 * ⚠️ Clamping, not rejecting. These are window bounds and page sizes read off a URL — a client
 * with a stale link should get the default view, not an error page. A parameter where a wrong
 * value would be a WRITE is a different matter and belongs in the handler.
 */
export function numParam(
  url: URL, name: string, fallback: number, range?: { min?: number; max?: number },
): number {
  const raw = url.searchParams.get(name);
  const n = raw == null || raw.trim() === "" ? fallback : Number(raw);
  const v = Number.isFinite(n) ? n : fallback;
  return Math.min(range?.max ?? Number.MAX_SAFE_INTEGER, Math.max(range?.min ?? Number.MIN_SAFE_INTEGER, v));
}
