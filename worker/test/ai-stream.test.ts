/**
 * The streamed-answer transport (`lib/ai/ai.ts`).
 *
 * Why this is a unit test and not a golden: there is no database state to snapshot and no fixture
 * that could produce a model response. What can go wrong here is entirely in the PARSING, and it
 * goes wrong in a way that is invisible in review and rare in a happy-path manual check —
 * a TCP chunk boundary landing in the middle of an SSE frame, of a JSON object, or of a UTF-8
 * character. Ukrainian text makes the last one certain rather than theoretical: every letter is
 * two bytes, so a split inside one is the normal case, not an edge case.
 *
 * The tests drive the real public functions with a faked `fetch`, so `demoClamp`, the usage
 * accounting and the tool loop all run exactly as they do in production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { callHaikuMessages, callMessagesRaw } from "../lib/ai/ai.ts";
import { migratedDb, testEnv, freezeTime } from "./harness.ts";
import { FROZEN_NOW_ISO } from "./fixture.ts";
import type { Env } from "../env.ts";

/** One SSE frame, in Anthropic's wire format. */
function frame(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** A complete text answer, as the API would send it. */
function textStream(parts: string[]): string {
  return [
    frame("message_start", { message: { usage: { input_tokens: 120, output_tokens: 0 } } }),
    frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ...parts.map((t) => frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: t } })),
    frame("content_block_stop", { index: 0 }),
    frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } }),
    frame("message_stop", {}),
  ].join("");
}

/**
 * Serve `body` as a stream cut into `size`-BYTE chunks.
 *
 * Bytes, not characters, and that is the whole point: chopping the string by characters would
 * never split a multi-byte letter, so the decoder's `{ stream: true }` would never be exercised
 * and the test would pass on code that mangles every second Cyrillic character.
 */
function fakeFetch(body: string, size: number): typeof fetch {
  return (async () => {
    const bytes = new TextEncoder().encode(body);
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= bytes.length) { c.close(); return; }
        c.enqueue(bytes.slice(i, i + size));
        i += size;
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

function env(): Env {
  const db = migratedDb();
  return testEnv(db) as unknown as Env;
}

async function withFetch<T>(f: typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try { return await run(); } finally { globalThis.fetch = real; }
}

const SYSTEM = [{ type: "text", text: "system" }];
const MSGS = [{ role: "user" as const, content: "питання" }];

test("stream: deltas arrive in order and rebuild the exact answer", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const parts = ["Твоя ", "подушка — ", "12 400 ₴", "."];
    const seen: string[] = [];
    const r = await withFetch(fakeFetch(textStream(parts), 7), () =>
      callHaikuMessages(env(), SYSTEM, MSGS, 100, "claude-haiku-4-5-20251001", (c) => { seen.push(c); }));

    assert.deepEqual(seen, parts, "each delta must surface once, whole, in order");
    assert.equal(r.text, parts.join(""), "the returned text must equal what was streamed");
    assert.equal(r.stop, "end_turn");
  } finally { restore(); }
});

test("stream: a chunk boundary inside a frame, a JSON object and a Cyrillic letter", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const parts = ["Витрати ", "зросли ", "на 12%"];
    const body = textStream(parts);
    // One byte at a time is the worst case the network can produce, and the cheapest way to prove
    // every boundary is handled: every frame, every JSON object and every two-byte letter is split.
    for (const size of [1, 3, 64, 100000]) {
      const seen: string[] = [];
      const r = await withFetch(fakeFetch(body, size), () =>
        callHaikuMessages(env(), SYSTEM, MSGS, 100, "claude-haiku-4-5-20251001", (c) => { seen.push(c); }));
      assert.equal(seen.join(""), parts.join(""), `chunk size ${size}: text corrupted`);
      assert.equal(r.text, parts.join(""), `chunk size ${size}: accumulated text corrupted`);
    }
  } finally { restore(); }
});

test("stream: usage is recorded from both ends of the stream", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const r = await withFetch(fakeFetch(textStream(["ok"]), 5), () =>
      callHaikuMessages(env(), SYSTEM, MSGS, 100, "claude-haiku-4-5-20251001", () => {}));
    // Input tokens are only in `message_start`, output tokens only in the final `message_delta`.
    // Taking either from one event alone silently under-reports the bill.
    assert.equal(r.usage.input_tokens, 120);
    assert.equal(r.usage.output_tokens, 42);
  } finally { restore(); }
});

test("stream: a tool call is reassembled from its JSON fragments", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    // `input_json_delta` fragments are a JSON string cut at arbitrary points — the pieces are not
    // valid JSON on their own, so they can only be concatenated and parsed at `content_block_stop`.
    const body = [
      frame("message_start", { message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
      frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tu_1", name: "query_spend", input: {} } }),
      frame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"from_da' } }),
      frame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: 'te":"2026-01-01",' } }),
      frame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '"flow":"spend"}' } }),
      frame("content_block_stop", { index: 0 }),
      frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } }),
    ].join("");

    const r = await withFetch(fakeFetch(body, 11), () =>
      callMessagesRaw(env(), SYSTEM, MSGS, 100, "claude-haiku-4-5-20251001", undefined, () => {}));

    assert.equal(r.stop, "tool_use");
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0].name, "query_spend");
    assert.deepEqual(r.content[0].input, { from_date: "2026-01-01", flow: "spend" });
  } finally { restore(); }
});

test("stream: an error event fails loudly instead of returning half an answer", async () => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    // Anthropic can fail mid-stream (overloaded). Half a sentence that looks finished is the one
    // outcome worse than an error, so this must throw rather than return what arrived so far.
    const body = [
      frame("message_start", { message: { usage: { input_tokens: 5, output_tokens: 0 } } }),
      frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Почав відпов" } }),
      frame("error", { error: { type: "overloaded_error", message: "overloaded" } }),
    ].join("");

    await assert.rejects(
      () => withFetch(fakeFetch(body, 9), () =>
        callHaikuMessages(env(), SYSTEM, MSGS, 100, "claude-haiku-4-5-20251001", () => {})),
      /overloaded/,
    );
  } finally { restore(); }
});
