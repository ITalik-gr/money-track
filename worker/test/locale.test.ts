/**
 * Which language the server answers in.
 *
 * The defect these lock down: language was resolved from `app_state.locale` alone, that column is
 * unset until someone opens Settings and switches, and unset was read as Ukrainian — while the
 * client's default is English. So a brand-new account and every demo visitor saw an English screen
 * and got Ukrainian category names, Ukrainian error strings and Ukrainian AI prose. Nothing was
 * broken in a way any single test would have caught, because every part was behaving as written.
 *
 * The rule now: the READER's language (the `x-mt-locale` header, arriving as `env.UI_LOCALE`) wins,
 * and the stored preference is the fallback for the paths that have no reader — cron, Telegram, the
 * alarm. Both halves are tested, because losing either one restores the bug in one direction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv } from "./harness.ts";
import { seed } from "./fixture.ts";
import { replyLangDirective, langNoteDirective } from "../lib/ai/prompt.ts";
import type { Env } from "../env.ts";

const dbWithLocale = (stored?: "uk" | "en") => {
  const db = migratedDb();
  seed(db);
  if (stored) {
    db.raw.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('locale', ?)").run(stored);
  }
  return db;
};

test("locale: the reader's language wins over the stored preference", async () => {
  const db = dbWithLocale("uk");
  const env = { ...testEnv(db), UI_LOCALE: "en" } as unknown as Env;
  const d = await replyLangDirective(env);
  assert.match(d, /natural English/);
  assert.doesNotMatch(d, /natural Ukrainian/);
});

test("locale: with no stored preference at all, the reader's language still decides", async () => {
  // THE regression. Before the header existed this returned the Ukrainian directive, because
  // "column unset" and "user chose Ukrainian" were the same value.
  const db = dbWithLocale();
  const env = { ...testEnv(db), UI_LOCALE: "en" } as unknown as Env;
  assert.match(await replyLangDirective(env), /natural English/);
});

test("locale: with no reader (cron, Telegram), the stored preference is used", async () => {
  const db = dbWithLocale("en");
  const env = testEnv(db) as unknown as Env; // no UI_LOCALE — this is what a cron run looks like
  assert.match(await replyLangDirective(env), /natural English/);

  const uk = dbWithLocale("uk");
  assert.match(await replyLangDirective(testEnv(uk) as unknown as Env), /natural Ukrainian/);
});

test("locale: the chat answers in the language it was written to, whatever the setting", async () => {
  // Conversation mode is a different rule on purpose: a Ukrainian question gets a Ukrainian
  // answer even on an English screen. The setting only decides the tie-break for a message too
  // short to tell — which is the part that must still follow the reader.
  const db = dbWithLocale();
  const d = await replyLangDirective({ ...testEnv(db), UI_LOCALE: "en" } as unknown as Env, "conversation");
  assert.match(d, /SAME language/);
  assert.match(d, /too short to tell, use English/);
});

test("locale: enrichment translates its one prose field and nothing else", async () => {
  const db = dbWithLocale();
  const en = await langNoteDirective({ ...testEnv(db), UI_LOCALE: "en" } as unknown as Env);
  // The point of a narrow directive: `clean_name` is a brand and must survive untranslated.
  assert.match(en, /`note` is the only field/);
  assert.match(en, /never translate or transliterate a brand name/);
});

test("locale: category names come back in the reader's language without a stored setting", async () => {
  // End to end through the middleware, not just the helper: `c.get("locale")` feeds `catNameSql`,
  // so this is what the screen actually receives.
  const db = dbWithLocale();
  const res = await api.request("/categories", {}, { ...testEnv(db), UI_LOCALE: "en" });
  const body = await res.json() as { name: string }[];
  const names = body.map((c) => c.name);
  assert.ok(names.includes("Groceries"), `expected an English seeded name, got: ${names.slice(0, 5).join(", ")}`);
  assert.ok(!names.includes("Продукти"), "a Ukrainian seeded name must not come back on an English screen");
});
