/**
 * §SUB-REVIEW — the model as a judge over the candidate list.
 *
 * Nothing here calls a model. What is pinned is the machinery AROUND the call, which is where
 * every way this feature can go wrong lives:
 *
 *  · which rows are even offered for judgement (a near-miss is a QUESTION, and the wrong set of
 *    questions is a wrong answer no prompt can fix);
 *  · which rows are asked about AGAIN — the difference between one call a month and one every
 *    night, forever, about merchants already decided;
 *  · that a verdict never silently deletes a row.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { recurringCandidates, nearMissCandidates, type ChargeRow } from "../lib/finance/recurring.ts";
import { needingReview, reviewKey } from "../lib/ai/subs-review.ts";
import type { SubReviewRow } from "../repo/planning.ts";
import type { RecurringCandidate } from "../../shared/api/planning.ts";

const DAY = 86400;
const NOW = Math.floor(Date.parse("2026-09-02T09:00:00Z") / 1000);

function series(merchant: string, amounts: number[], everyDays: number, from = NOW - DAY): ChargeRow[] {
  return amounts.map((amount, i) => ({
    merchant, amount, time: from - i * everyDays * DAY, currency_code: 980, category_id: null,
  }));
}

const stored = (rows: Partial<SubReviewRow>[]): Map<string, SubReviewRow> =>
  new Map(rows.map((r) => [r.merchant_key!, {
    merchant_key: r.merchant_key!, merchant: r.merchant ?? r.merchant_key!,
    verdict: r.verdict ?? "unsure", reason: r.reason ?? null, decided_at: r.decided_at ?? NOW,
  }]));

// ---- what becomes a question ---------------------------------------------------------------

test("a subscription whose PRICE ROSE mid-window is a near-miss, not a candidate", () => {
  // The cost `recurring.ts` names out loud: six charges at the old price, six at the new one, so
  // neither bucket owns 60% of the merchant and BUCKET_DOMINANCE throws the lot out. This is a
  // real Netflix, and before §SUB-REVIEW it was simply never proposed.
  const rows = [
    ...series("Netflix", [419_00, 419_00, 419_00, 419_00, 419_00, 419_00], 30),
    ...series("Netflix", [359_00, 359_00, 359_00, 359_00, 359_00, 359_00], 30, NOW - 181 * DAY),
  ];
  assert.deepEqual(recurringCandidates(rows, NOW), [], "the deterministic pass still refuses it");

  const near = nearMissCandidates(rows, NOW);
  assert.ok(near.length >= 1, "but it is offered for review");
  assert.equal(near[0].merchant, "Netflix");
  assert.equal(near[0].near_miss, "shop", "and the row carries WHICH gate it failed");
});

test("a group the deterministic pass ACCEPTED is never also a near-miss", () => {
  // Both lists reach the endpoint and are concatenated. If a passing group appeared in both, the
  // screen would show the same subscription twice — and once with an «AI» badge it did not earn.
  const rows = series("Claude.ai", [1070_00, 1062_00, 1084_00, 1059_00, 1078_00], 30);
  assert.equal(recurringCandidates(rows, NOW).length, 1);
  assert.deepEqual(nearMissCandidates(rows, NOW), []);
});

test("too few charges, one month, or a daily rhythm are NOT near-misses", () => {
  // These three are excluded on purpose. `too_few`/`one_month` have no rhythm to judge — that is
  // §AI-RECURRING's half of the question, answered from the charge itself on the day it lands —
  // and `cadence` means the interval is a day or a year, which no proposal can be made out of.
  assert.deepEqual(nearMissCandidates(series("Разово", [500_00], 30), NOW), [], "one charge");
  assert.deepEqual(
    nearMissCandidates(series("Тижнева серія", [500_00, 505_00, 495_00], 2, NOW - DAY), NOW),
    [], "three charges two days apart — a habit, not a bill",
  );
  // Two charges inside ONE Kyiv month: the months gate, not the rhythm gate.
  assert.deepEqual(nearMissCandidates(series("Двічі", [500_00, 500_00], 3, NOW - DAY), NOW), [], "one month");
});

test("a grocery shop is not rescued by the near-miss pass — it is only ASKED about", () => {
  // The point of the design: loosening the CONSTANT would let every shop back in permanently.
  // Loosening it into a question keeps «Сільпо» off the screen unless a model says otherwise,
  // and the endpoint only admits `verdict === "subscription"`.
  const amounts = [300_00, 312_00, 480_00, 525_00, 331_00, 790_00, 410_00, 429_00, 650_00, 308_00, 472_00, 510_00];
  const rows = amounts.map((amount, i) => ({
    merchant: "Сільпо", amount, time: NOW - (i * 14 + 1) * DAY, currency_code: 980, category_id: 1,
  }));
  assert.deepEqual(recurringCandidates(rows, NOW), []);
  const near = nearMissCandidates(rows, NOW);
  assert.ok(near.length > 0, "it is a question…");
  assert.ok(near.every((c) => c.merchant === "Сільпо"));
  // …and one the model gets asked ONCE, not once per price bucket — see the dedup test below.
});

// ---- what gets asked again -------------------------------------------------------------------

const cand = (merchant: string, extra: Partial<RecurringCandidate> = {}): RecurringCandidate => ({
  merchant, amount: 419_00, n: 5, first_time: NOW - 150 * DAY, last_time: NOW - DAY,
  months: 5, avg_interval_days: 30, currency_code: 980, category_id: null, ...extra,
});

test("a merchant with a definite verdict is never asked again", () => {
  // The whole cost model rests on this. Without it the pass re-decides every candidate every
  // night — the same sentence about the same merchant, paid for forever.
  const list = [cand("Netflix"), cand("Сільпо")];
  const have = stored([
    { merchant_key: reviewKey("Netflix"), verdict: "subscription", decided_at: NOW - 300 * DAY },
    { merchant_key: reviewKey("Сільпо"), verdict: "not", decided_at: NOW - 300 * DAY },
  ]);
  assert.deepEqual(needingReview(list, have, NOW), [], "age does not stale a decided verdict");
});

test("an `unsure` is asked again once it has aged out, and not before", () => {
  // «Unsure» usually means too few charges to tell, which the next month resolves on its own.
  const list = [cand("Щось")];
  const fresh = stored([{ merchant_key: reviewKey("Щось"), verdict: "unsure", decided_at: NOW - 5 * DAY }]);
  assert.deepEqual(needingReview(list, fresh, NOW), []);

  const old = stored([{ merchant_key: reviewKey("Щось"), verdict: "unsure", decided_at: NOW - 60 * DAY }]);
  assert.equal(needingReview(list, old, NOW).length, 1);
});

test("one merchant is one question, even when it arrives as two price buckets", () => {
  // A merchant whose prices split produces several near-miss rows. Asking about each of them
  // would pay N times for one answer AND could store two contradictory verdicts under the same
  // key, the second silently overwriting the first.
  const list = [cand("Сільпо", { amount: 300_00 }), cand("Сільпо", { amount: 520_00 }), cand("Netflix")];
  const todo = needingReview(list, stored([]), NOW);
  assert.equal(todo.length, 2);
  assert.deepEqual(todo.map((c) => c.merchant).sort(), ["Netflix", "Сільпо"]);
});

test("a merchant whose core token is empty is never asked about", () => {
  // `coreToken` returns nothing for a description with no word in it («***», «1234»). Such a row
  // has no stable key, so a verdict about it could never be found again — it would be re-asked
  // every night and stored under the empty string, where it would collide with every other one.
  assert.equal(reviewKey("****"), "");
  assert.deepEqual(needingReview([cand("****")], stored([]), NOW), []);
});

// ---- what reaches the screen -----------------------------------------------------------------

const DETECT = "/planned/detect";

/** A seeded database with a monthly biller whose price rose halfway — a near-miss, not a
 *  candidate — plus whatever `sub_review` rows the caller wants standing over it. */
async function detectWith(verdicts: [string, string, string][]) {
  const { api } = await import("../routes/api/index.ts");
  const { migratedDb, testEnv, freezeTime } = await import("./harness.ts");
  const { seed, FROZEN_NOW_ISO } = await import("./fixture.ts");
  const restore = freezeTime(FROZEN_NOW_ISO);
  const at = Math.floor(Date.parse(FROZEN_NOW_ISO) / 1000);
  try {
    const db = migratedDb();
    seed(db);
    db.raw.prepare("DELETE FROM sub_review").run();
    // Twelve monthly charges, six at each price: the bucket splits and BUCKET_DOMINANCE refuses it.
    for (let i = 0; i < 12; i++) {
      db.raw.prepare(
        `INSERT INTO transactions (id, account_id, source, time, amount, currency_code, merchant, category_id, created_at)
         VALUES (?, 'acc-uah', 'mono', ?, ?, 980, 'Kyivstar', 7, ?)`,
      ).run(`ks-${i}`, at - (i * 30 + 2) * DAY, i < 6 ? -300_00 : -240_00, at);
    }
    for (const [key, merchant, verdict] of verdicts) {
      db.raw.prepare(
        `INSERT INTO sub_review (merchant_key, merchant, verdict, reason, amount, currency_code, decided_at)
         VALUES (?, ?, ?, 'бо так', 30000, 980, ?)`,
      ).run(key, merchant, verdict, at - DAY);
    }
    const res = await api.request(DETECT, {}, testEnv(db) as never);
    assert.equal(res.status, 200);
    return await res.json() as RecurringCandidate[];
  } finally { restore(); }
}

test("a near-miss reaches the screen ONLY behind a `subscription` verdict", async () => {
  const without = await detectWith([]);
  assert.equal(without.filter((r) => r.merchant === "Kyivstar").length, 0,
    "unreviewed, a near-miss is not evidence of anything and must not be shown");

  const admitted = await detectWith([[reviewKey("Kyivstar"), "Kyivstar", "subscription"]]);
  const row = admitted.find((r) => r.merchant === "Kyivstar");
  assert.ok(row, "reviewed and called a bill, it is the recall the thresholds gave up");
  // Labelled, for the same reason §AI-RECURRING is: this row is on screen because a model
  // overruled a threshold, not because a rhythm was measured.
  assert.equal(row.near_miss, "shop");
  assert.equal(row.ai_verdict, "subscription");
});

test("a near-miss the model called `not` or `unsure` stays off the list", async () => {
  for (const verdict of ["not", "unsure"]) {
    const rows = await detectWith([[reviewKey("Kyivstar"), "Kyivstar", verdict]]);
    assert.equal(rows.filter((r) => r.merchant === "Kyivstar").length, 0, verdict);
  }
});

test("a `not` verdict on a DETERMINISTIC candidate travels with it — it does not delete the row", async () => {
  // The rule this whole design turns on. A silent filter is a filter nobody can correct: the
  // false positive it removes is visible as a row that stopped appearing, but a real subscription
  // it removes is invisible in every surface the app has.
  const plain = await detectWith([]);
  const victim = plain.find((r) => !r.ai && !r.near_miss);
  assert.ok(victim, "the fixture yields at least one measured candidate");

  const rows = await detectWith([[reviewKey(victim.merchant), victim.merchant, "not"]]);
  const still = rows.find((r) => r.merchant === victim.merchant);
  assert.ok(still, "the row is still in the response…");
  assert.equal(still.ai_verdict, "not", "…carrying the verdict, so the screen can file it away");
  assert.equal(still.ai_reason, "бо так", "…and the reason, so the person can disagree with it");
});
