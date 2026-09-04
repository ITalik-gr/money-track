/**
 * §ADVICE-LOOP — the adviser remembers what it said and what the user did with it.
 *
 * Three properties, and every one of them fails silently if it breaks:
 *
 *  · **A decision survives the next generation.** Advice is regenerated wholesale, so if identity
 *    came from a position in the array, the state set on the second suggestion would land on
 *    whatever the model happens to put second next time — and it would look entirely correct.
 *  · **Generating does not reset decisions.** `rememberSuggestions` is insert-only for exactly this
 *    reason; an overwrite would quietly undo every refusal on each run, and then re-offer what was
 *    refused, which is the behaviour this store exists to stop.
 *  · **An outcome is measured, never asserted.** «Delivery is down 15%» is the kind of encouraging
 *    sentence a model produces whether or not it is true, so the figure comes from the canon and
 *    only after a month has actually passed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  suggestionKey, rememberSuggestions, setSuggestionState, getSuggestionRecords,
  normaliseSuggestions, alreadySuggested, scoreTakenSuggestions,
} from "../lib/ai/advice-actions.ts";
import { migratedDb, testEnv, type MemDb } from "./harness.ts";
import { seed } from "./fixture.ts";
import type { Env } from "../env.ts";

const env = (db: MemDb) => testEnv(db) as unknown as Env;
const NOW = 1_780_000_000;
const DAY = 86_400;

const raw = (title: string, detail = "") => ({ title, detail });

test("§ADVICE-LOOP: a decision outlives the advice it was made on", async (t) => {
  await t.test("identity comes from the title, so re-ordering cannot move a state", async () => {
    const db = migratedDb(); seed(db);
    const e = env(db);
    const cut = "Скоротити доставку на 15%";
    await rememberSuggestions(e, [{ key: suggestionKey(cut), title: cut }], NOW);
    await setSuggestionState(e, suggestionKey(cut), "dismissed", { title: cut }, NOW);

    // The next generation returns the SAME advice in a different order, with a stray comma.
    const merged = normaliseSuggestions(
      [raw("Відкрити конверт на продукти"), raw("Скоротити доставку, на 15%")],
      await getSuggestionRecords(e),
    );
    assert.equal(merged[1].state, "dismissed", "punctuation is not a new suggestion");
    assert.equal(merged[0].state, "open", "and an unrelated one is untouched");
  });

  await t.test("a rewrite IS a new suggestion — honest rather than clever", async () => {
    const db = migratedDb(); seed(db);
    const e = env(db);
    await rememberSuggestions(e, [{ key: suggestionKey("Скоротити доставку"), title: "Скоротити доставку" }], NOW);
    await setSuggestionState(e, suggestionKey("Скоротити доставку"), "dismissed", {}, NOW);
    const merged = normaliseSuggestions([raw("Витрачати менше на їжу з доставкою")], await getSuggestionRecords(e));
    // Not a bug: a fuzzy key that merged these would hide a genuinely different suggestion for
    // ever. The guard against rewrites is §NOVELTY — the model is SHOWN what it already said.
    assert.equal(merged[0].state, "open");
  });

  await t.test("generating again does NOT reset what the user decided", async () => {
    const db = migratedDb(); seed(db);
    const e = env(db);
    const title = "Закрити підписку на музику";
    const key = suggestionKey(title);
    await rememberSuggestions(e, [{ key, title }], NOW);
    await setSuggestionState(e, key, "dismissed", { title }, NOW);
    // The adviser runs again and proposes the same thing.
    await rememberSuggestions(e, [{ key, title }], NOW + DAY);
    const rec = (await getSuggestionRecords(e)).get(key)!;
    assert.equal(rec.state, "dismissed", "an insert-only remember cannot undo a refusal");
    assert.equal(rec.state_at, NOW, "and it does not touch the timestamp either");
  });

  await t.test("§NOVELTY: what the model is told it has already said", async () => {
    const db = migratedDb(); seed(db);
    const e = env(db);
    await rememberSuggestions(e, [{ key: suggestionKey("A"), title: "A" }, { key: suggestionKey("B"), title: "B" }], NOW);
    await setSuggestionState(e, suggestionKey("B"), "dismissed", { title: "B" }, NOW + 10);
    const list = alreadySuggested(await getSuggestionRecords(e));
    const b = list.find((x) => x.title === "B")!;
    assert.equal(b.state, "dismissed", "the refusal travels WITH the title, or the list is just noise");
  });
});

test("§ADVICE-LOOP: the outcome is measured from the ledger", async (t) => {
  const CAT = 1;
  const setup = async (state: "taken" | "dismissed" | "open", at: number) => {
    const db = migratedDb(); seed(db);
    const e = env(db);
    const title = "Скоротити категорію";
    const key = suggestionKey(title);
    const metric = { kind: "category_month" as const, category_id: CAT, category_name: "Test", baseline: 10_000_00, at };
    await rememberSuggestions(e, [{ key, title, metric }], at);
    if (state !== "open") await setSuggestionState(e, key, state, { title }, at);
    return { e, key };
  };
  // The canon, as `buildAdvice` would hand it over: the category now costs 15% less.
  const levels = new Map([[CAT, { level: 8_500_00 }]]);

  await t.test("a taken suggestion, a month later, gets its real delta", async () => {
    const { e, key } = await setup("taken", NOW - 30 * DAY);
    await scoreTakenSuggestions(e, levels, NOW);
    const rec = (await getSuggestionRecords(e)).get(key)!;
    assert.equal(rec.outcome?.delta_pct, -15, "negative means the category costs less than before");
    assert.equal(rec.outcome?.current, 8_500_00);
  });

  await t.test("not before a month has passed — anything sooner is noise", async () => {
    const { e, key } = await setup("taken", NOW - 3 * DAY);
    await scoreTakenSuggestions(e, levels, NOW);
    assert.equal((await getSuggestionRecords(e)).get(key)!.outcome, null);
  });

  await t.test("a dismissed suggestion is never scored", async () => {
    const { e, key } = await setup("dismissed", NOW - 60 * DAY);
    await scoreTakenSuggestions(e, levels, NOW);
    assert.equal(
      (await getSuggestionRecords(e)).get(key)!.outcome, null,
      "grading someone on a plan they declined is not a measurement, it is a rebuke",
    );
  });

  await t.test("an untouched suggestion is not scored either — it measures nothing", async () => {
    const { e, key } = await setup("open", NOW - 60 * DAY);
    await scoreTakenSuggestions(e, levels, NOW);
    assert.equal((await getSuggestionRecords(e)).get(key)!.outcome, null);
  });

  await t.test("the baseline is captured ONCE, so marking again cannot flatten the delta", async () => {
    const { e, key } = await setup("taken", NOW - 30 * DAY);
    // The user re-marks it as done today. A baseline re-captured here would be today's level,
    // against which the improvement is zero by construction.
    await setSuggestionState(e, key, "done", {}, NOW);
    await scoreTakenSuggestions(e, levels, NOW);
    assert.equal((await getSuggestionRecords(e)).get(key)!.outcome?.delta_pct, -15);
  });
});
