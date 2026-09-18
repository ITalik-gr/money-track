/**
 * The bulk-enrich system prefix stays above Haiku's prompt-cache minimum.
 *
 * WHY A TEST AND NOT A COMMENT. There already WAS a comment — `prompt.ts` has said «cross Haiku's
 * 4096-token cache minimum» since the guide was written. The prefix drifted to 4 078 tokens
 * anyway, eighteen short, and stayed there: the API does not error, does not warn and does not
 * degrade, it simply bills the full input every time. `scripts/eval-ai.mjs` found it in its first
 * run, by reading `usage` on 49 real calls. This is the deterministic half of that finding — the
 * eval costs money and needs a key, and a rule that can only be checked by paying will not be
 * checked («Перевірка > інструкція»).
 *
 * WHY CHARACTERS AND NOT TOKENS. Counting tokens honestly means asking Anthropic, which makes this
 * a network test and defeats the purpose. So the bound is in characters, converted with a ratio
 * MEASURED against the real tokenizer rather than guessed: the 2026-09-18 prefix was 9 619
 * characters and 4 078 Haiku tokens, i.e. **2.36 characters per token** on this specific mix of
 * English instructions, Ukrainian merchant names and Latin brands. Different text would tokenize
 * differently, which is why the floor below carries a deliberate margin instead of sitting exactly
 * on the line.
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
