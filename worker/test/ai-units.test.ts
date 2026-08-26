/**
 * §0a — the unit the model is TOLD about must be the unit it is GIVEN.
 *
 * `moneyUnitDirective` said "minor units" while every payload it accompanies is in WHOLE units:
 * `collectFinanceSnapshot`'s context divides each amount by 100, and so do the chat tools
 * (`Math.round(r.amt / 100)`). A model handed a general instruction and a specific field believes
 * the field — which is exactly the reasoning that directive was written from — so here the
 * INSTRUCTION was the false half, and a model obeying it understated everything 100×: 12 500 ₴ of
 * rent read as ₴125.
 *
 * It survived twelve audits because both readings are plausible sentences about money and the
 * model often sanity-checks its way back to the right order of magnitude — intermittent, not
 * absent, which is the hardest kind to notice and the easiest kind to disbelieve.
 *
 * This file is the pin the ROADMAP card asked for: the claim is checked AGAINST A REAL SNAPSHOT,
 * not against another sentence. Restating the directive in a test would only pin the typo.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { moneyUnitDirective } from "../lib/ai/prompt.ts";
import { collectFinanceSnapshot } from "../lib/ai/advisor.ts";
import { migratedDb, freezeTime, testEnv, type MemDb } from "./harness.ts";
import { seed, FROZEN_NOW_ISO } from "./fixture.ts";
import type { Env } from "../env.ts";

const env = (m: MemDb) => testEnv(m) as unknown as Env;

test("§0a: the snapshot the model reads is in WHOLE units, and the directive says so", async (t) => {
  const restore = freezeTime(FROZEN_NOW_ISO);
  try {
    const m = migratedDb();
    seed(m);
    const snap = await collectFinanceSnapshot(env(m));
    const ctx = snap.context as Record<string, number>;

    await t.test("every headline figure is its minor-unit source divided by 100", () => {
      // The snapshot returns BOTH scales — minor at the top level, whole inside `context` — and
      // only `context` goes on the wire. That is the split the directive has to describe.
      assert.equal(ctx.liquid_cushion_uah, Math.round(snap.funds.cushion / 100));
      assert.equal(ctx.debt_uah, Math.round(snap.funds.debt / 100));
      assert.equal(ctx.own_funds_uah, Math.round(snap.ownFunds / 100));
      assert.equal(ctx.monthly_burn_uah, Math.round(snap.monthlyBurn / 100));
      // `subsMonthly` is documented as already-whole, so this one must NOT be divided again.
      assert.equal(ctx.subscriptions_monthly_uah, snap.subsMonthly);
    });

    await t.test("and nothing inside it is still in cents", () => {
      // A guard against the reverse mistake: adding a field to the context straight from the canon
      // (which is minor everywhere) would put two scales in one payload, and no sentence can
      // describe that correctly.
      const cushionMinor = snap.funds.cushion;
      if (cushionMinor > 0) {
        assert.ok(
          ctx.liquid_cushion_uah < cushionMinor,
          "the context value must be the divided one, not the raw minor figure",
        );
      }
    });

    await t.test("the directive states WHOLE units, not minor ones", async () => {
      const d = await moneyUnitDirective(env(m));
      assert.match(d, /WHOLE units/, "it has to name the scale the payload actually uses");
      assert.ok(!/minor units/.test(d), "the exact false claim that shipped");
      // The example is in the sentence on purpose: "whole units" is a phrase a model can read past,
      // «12500 means 12 500, not 125» is not.
      assert.match(d, /12500/);
    });

    await t.test("no prompt beside it names hryvnia as the unit", async () => {
      // §BASE-CUR: the display currency is a setting. A prompt saying "amounts are in UAH" over a
      // payload converted into dollars is the same defect one layer up — and there were ten of
      // them, each of which the directive then told the model to ignore.
      const { readFileSync, readdirSync } = await import("node:fs");
      const dir = "worker/lib/ai";
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && x !== "prompt.ts")) {
        const src = readFileSync(`${dir}/${f}`, "utf8");
        // Prompt strings only: a comment may still explain the history in these words.
        for (const line of src.split("\n")) {
          if (line.trim().startsWith("*") || line.trim().startsWith("//")) continue;
          assert.ok(
            !/in UAH|whole hryvnia|Amounts in hryvnia/i.test(line),
            `${f}: a prompt still names the unit itself — that is moneyUnitDirective's one job\n  ${line.trim()}`,
          );
        }
      }
    });
  } finally { restore(); }
});
