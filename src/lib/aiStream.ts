// Reading a streamed AI answer.
//
// Why this is a hand-written `fetch` rather than an RTK Query endpoint: RTK Query's contract is
// "one request, one settled result", and the whole value here is the states BETWEEN those two —
// the answer arriving word by word. Wrapping a stream in a mutation would mean buffering it to
// completion, which is the wait this exists to remove.
//
// The wire format is NDJSON (one JSON object per line), not SSE: nothing here needs event types,
// reconnection or last-event-id, and `EventSource` cannot POST a body at all. See the endpoint in
// `worker/routes/api/advisor.ts` for the other half.

import { getLocale } from "../i18n/locale.ts";

/** One line of the stream. `done` carries the authoritative full text; `error` ends it. */
type StreamLine =
  | { delta: string }
  | { done: true; reply: string }
  | { error: string };

export interface StreamHandlers {
  /** A fragment arrived — append it to what is on screen. */
  onDelta: (chunk: string) => void;
  /** The final, authoritative text. Replace the accumulated value with it. */
  onDone: (reply: string) => void;
}

/**
 * POST `body` and drive `handlers` as the answer streams back.
 *
 * Throws for a request that never started (no key, rate limit, network) — those are ordinary
 * failures with a status and a JSON body, so `errText()` handles them like any other.
 *
 * ⚠️ A failure AFTER the first byte cannot change the status code — it is already 200. The server
 * sends `{error}` in the stream for that case and this throws it, so a model failure at second 20
 * still reaches the reader as a sentence instead of a silently truncated answer.
 */
export async function streamChat(
  path: string,
  body: unknown,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    // `x-mt-locale` by hand, because this is the one API call that does not go through RTK
    // Query's `prepareHeaders` — and it is the most language-visible call in the app.
    headers: { "content-type": "application/json", "x-mt-locale": getLocale() },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    // Same shape as every other API failure, so the caller's `errText` says something real.
    const data = await res.json().catch(() => null) as { error?: string } | null;
    throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { status: res.status, data });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let settled = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Only whole lines are parsed: a chunk boundary can fall anywhere, including the middle of a
    // multi-byte character or of the JSON itself.
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: StreamLine;
      try { msg = JSON.parse(line) as StreamLine; } catch { continue; }
      if ("error" in msg) throw new Error(msg.error);
      if ("delta" in msg) handlers.onDelta(msg.delta);
      else if ("done" in msg) { handlers.onDone(msg.reply); settled = true; }
    }
  }

  // The stream ended without saying so — a dropped connection mid-answer. Treated as a failure
  // rather than as a short answer: half a sentence that looks finished is worse than an error.
  if (!settled) throw new Error("stream ended before the answer was complete");
}
