/**
 * Per-user request ceilings (C1).
 *
 * Until this existed, only the demo had limits. An authenticated user — or anyone holding a
 * stolen session cookie, which stays valid for 30 days — could hammer any endpoint as fast as the
 * network allowed. On the analytics routes that costs CPU; on the AI routes it costs money, on
 * OUR Anthropic key for the owner and on the user's own key otherwise, with nothing between the
 * request loop and the invoice.
 *
 * ## Why in memory, and why that is enough here
 *
 * This runs INSIDE the user's Durable Object, so:
 *   - the object *is* the user — no per-user key is needed, and one user cannot spend another's
 *     budget by construction;
 *   - a DO is single-threaded, so read-modify-write on this map has no races. A counter in the
 *     Worker would need atomic storage to be correct;
 *   - persisting the window would mean a storage WRITE on every request, which is a real cost
 *     paid on every legitimate request to slow down the rare abusive one.
 *
 * The trade-off is that an evicted object forgets its window. That is acceptable precisely
 * because of when it matters: an object under a request flood is by definition warm and never
 * evicted. Eviction only forgives someone who already stopped.
 *
 * ## Why two buckets
 *
 * A single limit cannot be both. It must be loose enough for a dashboard that legitimately fires
 * ~15 parallel reads on load, and that same number applied to `/advisor/chat` is dozens of Sonnet
 * calls. So expensive routes get their own, much smaller window.
 */

/** Cheap reads/writes: generous, sized to never inconvenience a human clicking around. */
const GENERAL = { limit: 240, windowMs: 60_000 };
/** Anything that reaches Anthropic. Sized in "how many can a person actually read". */
const AI = { limit: 30, windowMs: 5 * 60_000 };

/**
 * Routes that spend money with the model. Matched as prefixes against the pathname, with `:id`
 * segments handled by the two-part checks below.
 *
 * Kept as an explicit list rather than "everything that is a POST": most POSTs here are ordinary
 * writes (creating a budget, editing a transaction), and putting them under the AI ceiling would
 * make normal bookkeeping hit a limit meant for model calls.
 */
const AI_PATHS = [
  "/api/advisor/generate",
  "/api/advisor/chat",
  "/api/insight/generate",
  "/api/reports/generate",
  "/api/budgets/propose",
  "/api/budgets/chat",
  "/api/planned/ai-detect",
  "/ingest/",
];
/** `/api/transactions/<id>/chat`, `/api/transactions/<id>/enrich`, `/api/events/<id>/ai|chat`. */
const AI_SUFFIXES = ["/chat", "/enrich", "/ai"];

export function isAiPath(path: string): boolean {
  if (AI_PATHS.some((p) => path.startsWith(p))) return true;
  return (
    (path.startsWith("/api/transactions/") || path.startsWith("/api/events/")) &&
    AI_SUFFIXES.some((s) => path.endsWith(s))
  );
}

const hits: Map<string, number[]> = new Map();

export interface RateVerdict {
  ok: boolean;
  /** Seconds until the oldest hit in the window expires. Only meaningful when `ok` is false. */
  retryAfter: number;
}

/**
 * Record one request against a bucket and say whether it is allowed.
 *
 * A rejected request is NOT recorded: otherwise a client that keeps retrying would keep pushing
 * its own window forward and stay locked out long after it slowed down — a limiter that punishes
 * retrying harder than it punishes the original burst.
 */
export function checkRate(bucket: "general" | "ai", now = Date.now()): RateVerdict {
  const { limit, windowMs } = bucket === "ai" ? AI : GENERAL;
  const cutoff = now - windowMs;

  const kept = (hits.get(bucket) ?? []).filter((t) => t > cutoff);
  if (kept.length >= limit) {
    // `kept` is ascending, so the oldest hit is the one whose expiry frees a slot.
    const retryAfter = Math.max(1, Math.ceil((kept[0]! + windowMs - now) / 1000));
    hits.set(bucket, kept);
    return { ok: false, retryAfter };
  }
  kept.push(now);
  hits.set(bucket, kept);
  return { ok: true, retryAfter: 0 };
}

/** Test seam — the map is module state, so a test would otherwise leak between cases. */
export function resetRateLimits(): void {
  hits.clear();
}
