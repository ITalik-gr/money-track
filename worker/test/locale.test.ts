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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { api } from "../routes/api/index.ts";
import { migratedDb, testEnv } from "./harness.ts";
import { seed } from "./fixture.ts";
import { replyLangDirective, langNoteDirective } from "../lib/ai/prompt.ts";
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

test("locale: the reader's language reaches the AI context, not just the prose", async () => {
  // The other half of the same bug: the screen said "Groceries" while the model was handed
  // «Продукти», because `catNameSql` was used in `repo/*` and nowhere in `lib/ai/*`. Even a
  // correctly English answer then named its categories in Ukrainian.
  const db = dbWithLocale();
  const env = { ...testEnv(db), UI_LOCALE: "en" } as unknown as Env;
  const { collectFinanceSnapshot } = await import("../lib/ai/advisor.ts");
  const snap = await collectFinanceSnapshot(env);
  const json = JSON.stringify(snap.context);
  assert.ok(!/Продукти|Кафе і ресторани|Транспорт/.test(json),
    "a Ukrainian seed category name reached the model's context on an English screen");
});

/**
 * A demo sandbox must start with NO language of its own.
 *
 * `worker/demo/dataset.json` is a dump of the OWNER's object, so every `app_state` row in it is the
 * owner's setting frozen when `scripts/seed-demo.mjs` last ran — including `locale`. That row made
 * the sandbox the one account where a stored preference existed for someone who had never expressed
 * one, so `resolveLocale` had a stored answer to prefer and the visitor's `x-mt-locale` never got a
 * say. Reported exactly as: the toggle says EN, the screen is English, and the category names and
 * the AI answer come back Ukrainian.
 */
test("locale: the demo seed carries no language of its own", async () => {
  const here = fileURLToPath(new URL(".", import.meta.url).href);
  // The fixture is read from disk rather than imported: `demo-load.ts` imports it as a Vite JSON
  // module, which Node's test runner will not load without an import attribute. Reading the file
  // also tests the thing that actually matters — what the committed snapshot contains today.
  const dataset = JSON.parse(readFileSync(`${here}../demo/dataset.json`, "utf8")) as
    { app_state?: { key: string; value: string }[] };
  const state = dataset.app_state ?? [];
  assert.ok(state.length > 0, "the fixture still seeds app_state (advice, rates, profile)");

  const { DEMO_EXCLUDED_STATE_KEYS } = await import("../lib/platform/demo.ts");
  for (const row of state) {
    if (row.key === "locale") {
      assert.ok(
        DEMO_EXCLUDED_STATE_KEYS.has("locale"),
        "the fixture carries app_state.locale and the loader no longer drops it — every demo " +
        "visitor would inherit the language of whoever last ran scripts/seed-demo.mjs",
      );
    }
  }
  // Only the language is dropped. Removing more would empty the demo's pre-baked advice, which is
  // the whole reason the sandbox looks like a real account at $0.
  assert.deepEqual([...DEMO_EXCLUDED_STATE_KEYS], ["locale"]);
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

/**
 * The stronger half of the same rule, and the one that actually fixed the bug.
 *
 * Naming no language was not enough: the prompts were WRITTEN in Ukrainian — ~32 000 characters of
 * it, opening with a 26k knowledge corpus as the first cached block. An instruction cannot outvote
 * that mass, and it did not, three reports running. Prompts are now English, so an English reader
 * gets an English prompt over English data and the answer follows by construction rather than by
 * request.
 *
 * A budget rather than a ban, because some Cyrillic in these files is DATA and must stay: merchant
 * strings matched against real bank descriptions («АТБ», «Сільпо»), Cyrillic character classes in
 * regexes, the `uk` half of the knowledge docs' UI title/summary pair, and one example of what NOT
 * to transliterate. The number is what keeps a new Ukrainian PARAGRAPH from slipping in unnoticed —
 * prose runs to thousands of characters, and the gap between 744 and 2000 is large enough that
 * only prose closes it.
 */
test("locale: AI prompts are written in English, not merely instructed to answer in one", () => {
  const here = fileURLToPath(new URL(".", import.meta.url).href);
  const files = [
    "tasks.ts", "generate.ts", "report.ts", "insight.ts", "advisor.ts", "chat-tools.ts",
    "enrich.ts", "receipt.ts", "prompt.ts", "json.ts", "ai.ts", "facts.ts",
    "knowledge/index.ts", "knowledge/personal-finance.ts", "knowledge/app-methodology.ts",
    "knowledge/investing.ts",
  ];
  let total = 0;
  const worst: { file: string; n: number }[] = [];
  for (const f of files) {
    const n = (stripComments(readFileSync(`${here}../lib/ai/${f}`, "utf8")).match(/[а-яїієґА-ЯЇІЄҐ]/g) ?? []).length;
    total += n;
    if (n > 0) worst.push({ file: f, n });
  }
  worst.sort((a, b) => b.n - a.n);
  assert.ok(
    total < 2000,
    `Cyrillic in lib/ai prompt strings is ${total} characters (budget 2000). Prompts are written ` +
    `in English — a Ukrainian one pulls the answer into Ukrainian no matter what the directive ` +
    `says. Largest: ${worst.slice(0, 4).map((w) => `${w.file}=${w.n}`).join(", ")}`,
  );
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
