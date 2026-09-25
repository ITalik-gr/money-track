/**
 * The bulk-enrich system prefix stays above Haiku's 4096-token cache minimum. Below it the API bills
 * full input every call without any error; the prefix once drifted 18 tokens short.
 * Characters, not tokens: 2.36 chars/token was measured on the real tokenizer (2026-09-18).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import { buildSystemPrefix } from "../lib/ai/prompt.ts";
import type { Env } from "../env.ts";

/** Measured on the real tokenizer, not assumed. See the header. */
const CHARS_PER_TOKEN = 2.36;
const HAIKU_CACHE_MIN_TOKENS = 4096;
/** ~400 tokens of slack: enough that ordinary edits to the guide cannot silently cross back. */
const REQUIRED_TOKENS = HAIKU_CACHE_MIN_TOKENS + 400;
const REQUIRED_CHARS = Math.ceil(REQUIRED_TOKENS * CHARS_PER_TOKEN);

function envWith(db: ReturnType<typeof migratedDb>): Env {
  return { DB: db } as unknown as Env;
}

test("the cached enrich prefix clears Haiku's cache minimum with margin", async () => {
  const db = migratedDb();
  const prefix = await buildSystemPrefix(envWith(db), "categorise one transaction", true);
  const chars = prefix.reduce((n, b) => n + (b.text?.length ?? 0), 0);

  assert.ok(
    chars >= REQUIRED_CHARS,
    `The cached prefix is ${chars} characters (~${Math.round(chars / CHARS_PER_TOKEN)} tokens). ` +
      `Haiku will not cache under ${HAIKU_CACHE_MIN_TOKENS} tokens, and a prefix below that line is ` +
      `billed in full on EVERY bulk-enrich call while looking exactly like a working cache. ` +
      `Keep CACHE_GUIDE at ${REQUIRED_CHARS}+ characters, or move the caching decision deliberately ` +
      `and change this test with it.`,
  );
});

test("the cached prefix actually carries cache_control, and the lean one does not", async () => {
  const db = migratedDb();
  // Both halves matter. Without the marker the size is pointless; with the marker on the small
  // prefix we would pay the cache-write premium for something that is never read back.
  const cached = await buildSystemPrefix(envWith(db), "task", true);
  const lean = await buildSystemPrefix(envWith(db), "task", false);

  assert.ok(cached.at(-1)?.cache_control, "the bulk prefix must mark its stable tail for caching");
  assert.equal(lean.at(-1)?.cache_control, undefined, "the lean prefix must not pay the write premium");
});
