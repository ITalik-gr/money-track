/**
 * §LANG — the READER's language (`x-mt-locale` → `env.UI_LOCALE`) decides; the stored preference
 * only without a reader (cron, Telegram). An unset column once read as Ukrainian.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv } from "./harness.ts";
import { seed } from "./fixture.ts";
import { resolveLocale } from "../lib/platform/i18n.ts";
import { withUserHeader, localeFromHeader } from "../lib/platform/forward.ts";
import type { Env } from "../env.ts";

/** Comments explain WHY and may legitimately name (or be written in) a language. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\/.*$/gm, "");

const dbWithLocale = (stored?: "uk" | "en") => {
  const db = migratedDb();
  seed(db);
  if (stored) {
    db.raw.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('locale', ?)").run(stored);
  }
  return db;
};

/**
 * `resolveLocale` is now the ONE answer to "what language is this request in".
 *
 * It replaced four implementations that gave two different answers: the `/api` middleware read the
 * reader first, while `ownerLocale(db)` and two private copies in `notify.ts`/`deliver.ts` read
 * only `app_state.locale`. Twenty call sites took the second kind, so the entire AI surface, the
 * notification feed, `/ingest`, `/setup`, `/import` and `/credentials` ignored the reader — and the
 * stored column is empty for anyone who never opened Settings, which read as Ukrainian.
 */
test("locale: resolveLocale takes the reader over the stored preference", async () => {
  const db = dbWithLocale("uk");
  assert.equal(await resolveLocale({ ...testEnv(db), UI_LOCALE: "en" } as unknown as Env), "en");
});

test("locale: resolveLocale falls back to the stored preference with no reader", async () => {
  // Cron, Telegram and the DO alarm have no request and therefore no header. This is the ONLY
  // situation in which the stored column decides.
  assert.equal(await resolveLocale(testEnv(dbWithLocale("en")) as unknown as Env), "en");
  assert.equal(await resolveLocale(testEnv(dbWithLocale("uk")) as unknown as Env), "uk");
});

test("locale: an unset column does not override the reader", async () => {
  // THE defect, in its most direct form. A brand-new account and every demo sandbox have no row
  // at all, and "no row" used to mean Ukrainian while the client's default is English.
  assert.equal(await resolveLocale({ ...testEnv(dbWithLocale()), UI_LOCALE: "en" } as unknown as Env), "en");
});

/**
 * The Worker→Durable Object hop must not lose the reader's language.
 *
 * `withUserHeader` rebuilds the Request to stamp the user id and the owner flag onto it, and a
 * rebuild is exactly where a header goes missing. Everything downstream — `catNameSql`, `st()`,
 * `replyLangDirective` — reads `env.UI_LOCALE`, which exists only if this survives.
 */
test("locale: x-mt-locale survives forwarding into the object", () => {
  const get = new Request("https://x/api/transactions", { headers: { "x-mt-locale": "en" } });
  assert.equal(localeFromHeader(withUserHeader(get, "demo:abc", false)), "en");
  // The chat stream is a POST with a body — the case where a naive rebuild drops headers.
  const post = new Request("https://x/api/advisor/chat/stream", {
    method: "POST", headers: { "x-mt-locale": "en", "content-type": "application/json" }, body: "{}",
  });
  assert.equal(localeFromHeader(withUserHeader(post, "demo:abc", false)), "en");
  // An unknown value must not become a third locale.
  const junk = new Request("https://x/api/x", { headers: { "x-mt-locale": "de" } });
  assert.equal(localeFromHeader(junk), undefined);
});

/**
 * The regression that sent this test back to the queue a second time: the plumbing above was all
 * correct, and the answer still came back in Ukrainian on an English screen — because the PROMPTS
 * named a language themselves. `chatAdvice`'s persona opened with «Відповідай українською», the
 * report asked for a «звіт українською», the feed observations even banned English words outright.
 * Those sentences sit in the FIRST system block and read as part of who the model is, while
 * `replyLangDirective` is one line appended much later. Two instructions, and the wrong one won.
 *
 * So the rule is now checked, not remembered: a prompt names no language, ever. Language is
 * `replyLangDirective`'s single job — anything else is a second source of truth for one decision,
 * which is the exact shape of §CUR-PLAN and §REFUND.
 */
test("locale: no AI prompt names a language of its own", () => {
  const here = fileURLToPath(new URL(".", import.meta.url).href);
  // `prompt.ts` is excluded on purpose: it IS the directive, and naming languages is its job.
  const files = ["tasks.ts", "generate.ts", "report.ts", "insight.ts", "advisor.ts", "chat-tools.ts", "enrich.ts", "receipt.ts"];
  for (const f of files) {
    const src = stripComments(readFileSync(`${here}../lib/ai/${f}`, "utf8"));
    const offender = src.split("\n").find((l) => /українськ|ukrainian|англійськ|english/i.test(l));
    assert.equal(
      offender,
      undefined,
      `${f} names a language inside a prompt — that instruction competes with replyLangDirective ` +
      `and wins, because it sits in the first system block:\n  ${offender?.trim()}`,
    );
  }
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
