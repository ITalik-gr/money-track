/**
 * §INCOME-SPLIT — of every hryvnia that came IN, where did it go.
 *
 * The page has both halves and never joins them. `ImportanceBreakdown` says what share of SPENDING
 * was essential, discretionary or optional — three numbers that add to 100% of the spending and
 * therefore say nothing about whether that spending was affordable. The savings-rate fact says one
 * number about the gap. Neither answers the question a person actually asks in a bad month:
 * **«з того, що я заробив, скільки з'їло обов'язкове, а скільки я вирішував сам»**.
 *
 * Expressed against INCOME the same three shares become a judgement rather than a description:
 * essentials at 40% of income is a life with room in it, essentials at 95% is one without, and the
 * spending breakdown is identical in both.
 *
 * ⚠️ **Both sides are the canon.** Income is `INCOME_WHERE` + `incomeSum` (so a refund is not
 * income and an unallocated reimbursement remainder is — §REFUND, §COMPENSATION), spending is
 * `SPEND_WHERE` + `EFF_IMPORTANCE`. Computing either one privately here would put a second answer
 * about the same money one block away from the first.
 *
 * ⚠️ **`left` can be NEGATIVE, and it is shown that way.** Spending more than came in is the whole
 * point of asking; clamping it at zero would make the block incapable of reporting the only
 * situation it exists for. The shares are of INCOME, so they sum past 100% exactly then — which is
 * the honest picture and the reason this is not drawn as a pie.
 *
 * ⚠️ **A period with no income has no answer** (`income === 0` → `null`), rather than 0%. «Все
 * пішло на обов'язкове» about a month with nothing coming in is a division by zero wearing a
 * sentence, and `savingsRatePct` already refuses the same way for the same reason.
 */
import type { Env } from "../../env.ts";
import {
  STATS_JOINS, EFF_IMPORTANCE, SPEND_WHERE, INCOME_WHERE, incomeSum, amountSum, valueMode,
} from "./stats.ts";
import type { Rates } from "./money.ts";
import type { IncomeAllocation } from "../../../shared/api/insights.ts";


interface Row { importance: string; spent: number }

export async function incomeAllocation(
  env: Env, rates: Rates, from: number, to: number,
): Promise<IncomeAllocation> {
  const { mult } = valueMode(rates, null);

  const [inc, rows] = await Promise.all([
    env.DB.prepare(
      `SELECT ${incomeSum(mult)} AS income
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time < ? AND ${INCOME_WHERE}`,
    ).bind(from, to).first<{ income: number | null }>(),
    env.DB.prepare(
      `SELECT ${EFF_IMPORTANCE} AS importance, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time < ? AND ${SPEND_WHERE}
       GROUP BY ${EFF_IMPORTANCE}`,
    ).bind(from, to).all<Row>(),
  ]);

  const income = Math.max(0, Math.round(inc?.income ?? 0));
  const bucket = { essential: 0, discretionary: 0, optional: 0 };
  for (const r of rows.results ?? []) {
    // `amountSum` sums `-EFF_AMOUNT`, so SPENDING ALREADY COMES BACK POSITIVE — the same
    // convention every other canonical breakdown uses. Flipping it again here inverted the whole
    // block: essentials read −7% of income and `left` read 146%, i.e. the app reported that
    // spending money had increased what was left of it. Caught by probing the endpoint against
    // the fixture, not by a type — both readings are numbers.
    // A refund inside a band legitimately pulls it back down (§REFUND); that is the one case
    // where a band may be negative, and it is real.
    const v = Math.round(r.spent);
    if (r.importance === "essential") bucket.essential += v;
    else if (r.importance === "optional") bucket.optional += v;
    else bucket.discretionary += v;
  }

  const spent = bucket.essential + bucket.discretionary + bucket.optional;
  const left = income - spent;
  const share = (v: number) => Math.round((v / income) * 1000) / 1000;

  return {
    from, to, income,
    ...bucket,
    left,
    shares: income > 0
      ? { essential: share(bucket.essential), discretionary: share(bucket.discretionary), optional: share(bucket.optional), left: share(left) }
      : null,
  };
}
