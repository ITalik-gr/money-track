/**
 * `/insights/*` — derived READINGS of a period, as opposed to its raw analytics.
 *
 * A separate prefix, and therefore a separate file, on purpose. `/analytics/*` is owned by
 * `analytics.ts` (C7: one file owns one first segment) and that file sits at its size exception,
 * which may never rise (C3). The alternative to a new prefix was to raise a cap the project has
 * twice refused to raise, or to split someone else's file mid-flight.
 *
 * The line between the two is real, not just administrative: everything here answers a question
 * ABOUT the period's numbers — how concentrated, how sustained, how affordable — while
 * `/analytics/*` answers what the numbers ARE. Every figure below is still computed by the canon
 * in `lib/finance/*`; nothing in this file knows arithmetic.
 */
import { apiRoutes, numParam } from "./_shared.ts";
import { getRates } from "../../lib/finance/money.ts";
import { localMonthStart } from "../../lib/finance/stats.ts";
import type {
  SpendProfile, Momentum, IncomeAllocation, SpendFloor,
} from "../../../shared/api/insights.ts";

export const insights = apiRoutes();

/** Default window when the caller names none: the current month so far, like the page's own default. */
function window(url: URL, now: number): { from: number; to: number } {
  const from = numParam(url, "from", localMonthStart(now));
  const to = numParam(url, "to", now);
  return { from, to };
}

// §SPEND-PROFILE — quiet days, merchant concentration, and money spent at merchants never seen
// before this window. Three answers over ONE population, so they are one request: they share the
// window and the `SPEND_WHERE` population, and splitting them would make three round trips ask the
// same question three times.
insights.get("/insights/spend-profile", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const { from, to } = window(new URL(c.req.url), now);
  const { spendProfile } = await import("../../lib/finance/spend-profile.ts");
  return c.json(await spendProfile(c.env, await getRates(c.env), from, to, now) satisfies SpendProfile);
});

// §MOMENTUM — categories that have moved the same way for three complete months or more. Takes no
// window: the question is about a run of MONTHS, and a caller-chosen range could not contain one.
insights.get("/insights/momentum", async (c) => {
  const { categoryMomentum } = await import("../../lib/finance/momentum.ts");
  return c.json(await categoryMomentum(c.env, await getRates(c.env)) satisfies Momentum);
});

// §INCOME-SPLIT — of what came in, what each importance band took.
insights.get("/insights/income-split", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const { from, to } = window(new URL(c.req.url), now);
  const { incomeAllocation } = await import("../../lib/finance/income-allocation.ts");
  return c.json(await incomeAllocation(c.env, await getRates(c.env), from, to) satisfies IncomeAllocation);
});

// §FLOOR — the repeating half of the burn, what it is made of, and the two runways side by side.
insights.get("/insights/floor", async (c) => {
  const { spendFloor } = await import("../../lib/finance/floor.ts");
  return c.json(await spendFloor(c.env, await getRates(c.env)) satisfies SpendFloor);
});
