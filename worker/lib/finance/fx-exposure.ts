/**
 * §FX-EXPOSURE — which currencies your money and your spending sit in, and what a 10% move does.
 *
 * `FxCost` (§FX-COST) answers what conversion COST — backward-looking. The Accounts page already
 * splits own funds by currency. Neither answers the forward question that moves the biggest number
 * on the screen for a multi-currency ledger: «if the dollar gains 10% against my currency, what
 * happens to my capital, and to my monthly spending?» — the two point in OPPOSITE directions for
 * someone who saves in dollars and pays dollar subscriptions, and seeing both is the point.
 *
 * ⚠️ A SENSITIVITY, never a forecast: «+10%» is a what-if the card states as one. A modelled number
 * that reads like a prediction is what §TIME-CTX and `numbersAreGrounded` exist to prevent.
 * ⚠️ Relative to the READER's base (§BASE-CUR): for a dollar reader the hryvnia is the foreign one.
 * Assets are `computeSummary().byCurrency` — the canon's own funds per currency (credit limit never
 * counted as money, §5). Spending is canonical spend grouped by the OPERATION's currency
 * (`original_currency`, else the account's): a dollar subscription paid from a hryvnia card is
 * exposure to the dollar.
 */
import type { Env } from "../../env.ts";
import type { FxExposure } from "../../../shared/api/insights.ts";
import { toBaseMinor, resolveBaseCurrency, type Rates } from "./money.ts";
import { computeSummary } from "./finance.ts";
import { STATS_JOINS, SPEND_WHERE, amountSum, valueMode, localMonthStart } from "./stats.ts";

const MOVE = 0.1;
const SPEND_MONTHS = 3;

export async function fxExposure(
  env: Env, rates: Rates, now = Math.floor(Date.now() / 1000),
): Promise<FxExposure> {
  const { mult } = valueMode(rates, null);
  const base = await resolveBaseCurrency(env);
  const [summary, spendRows] = await Promise.all([
    computeSummary(env),
    env.DB.prepare(
      `SELECT COALESCE(t.original_currency, t.currency_code) AS code, ${amountSum(mult)} AS spent
       FROM transactions t ${STATS_JOINS}
       WHERE t.time >= ? AND t.time < ? AND ${SPEND_WHERE}
       GROUP BY code`,
    ).bind(localMonthStart(now, -SPEND_MONTHS), localMonthStart(now)).all<{ code: number; spent: number }>(),
  ]);

  const assetsRaw = summary.byCurrency
    .map((c) => ({ currency_code: c.currency_code, amount: toBaseMinor(c.own, c.currency_code, rates) }))
    .filter((c) => c.amount !== 0);
  const assetTotal = assetsRaw.reduce((s, c) => s + Math.abs(c.amount), 0);
  const spendRaw = (spendRows.results ?? [])
    .map((r) => ({ currency_code: r.code, monthly: Math.round((r.spent ?? 0) / SPEND_MONTHS) }))
    .filter((r) => r.monthly > 0);
  const spendTotal = spendRaw.reduce((s, r) => s + r.monthly, 0);

  const foreign = (code: number) => code !== base;
  return {
    base_currency: base,
    assets: assetsRaw
      .map((c) => ({ ...c, share: assetTotal > 0 ? Math.abs(c.amount) / assetTotal : 0 }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    spend: spendRaw
      .map((r) => ({ ...r, share: spendTotal > 0 ? r.monthly / spendTotal : 0 }))
      .sort((a, b) => b.monthly - a.monthly),
    // Every foreign currency moving +10% against the base at once — the simplest honest what-if.
    move_pct: MOVE * 100,
    assets_delta: Math.round(assetsRaw.filter((c) => foreign(c.currency_code)).reduce((s, c) => s + c.amount, 0) * MOVE),
    spend_delta_monthly: Math.round(spendRaw.filter((r) => foreign(r.currency_code)).reduce((s, r) => s + r.monthly, 0) * MOVE),
  };
}
