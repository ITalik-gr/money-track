/**
 * §ENV-PARTS — what an envelope's month is MADE OF: committed, rhythmic, discretionary.
 *
 * Split out of `budgets.ts` on 2026-09-04 under lint C3, and the seam is a real one. Everything
 * left there is about a LIMIT — the carry it inherits, the ratio against it, where the month
 * closes, whether the plan held. This file answers a different question: of the money already
 * spent, how much was never a decision. It is also the only part of the envelope path that talks
 * to the subscription detectors, so the dependency belongs on one side of a boundary rather than
 * threaded through a file about budgets.
 *
 * ⚠️ **No third definition of «recurring» is created here.** That question already has two answers
 * in this codebase and they are deliberate: §PLAN-LINK for what the user DECLARED
 * (`transactions.planned_id`) and §SUB-DETECT for what the ledger MEASURES (`recurringCandidates`).
 * This file only asks them and adds up the answers. Inventing a third rule would put two different
 * numbers about the same subscription on the Plan page and the Subscriptions page — the defect
 * §CUR-PLAN and §SUB-MONTH were both written to close.
 */
import type { Env } from "../../env.ts";
import type { EnvelopeParts } from "../../../shared/api/planning.ts";
import { coreToken } from "./merchants.ts";
import { recurringCandidates, type ChargeRow } from "./recurring.ts";
import { STATS_JOINS, SPEND_WHERE, EFF_CAT_ID, EFF_AMOUNT } from "./stats.ts";

/**
 * §ENV-PARTS — how far back a rhythm is measured for the envelope split.
 *
 * 400 days, the SAME window `/planned/detect` uses. Not a new number: this classifies a charge
 * with the very detector that would PROPOSE the plan for it, and a shorter window here would make
 * the Plan page call a charge discretionary while the Subscriptions page offers to turn its
 * merchant into a subscription — one ledger, two answers, on two screens a person reads together.
 */
const RHYTHM_WINDOW_DAYS = 400;

/**
 * §ENV-PARTS — split each envelope's month into committed / rhythmic / discretionary.
 *
 * ⚠️ **The query is narrowed to merchants that actually spent something THIS month.** The obvious
 * shape — load the whole 400-day charge history and run the detector over it, exactly as
 * `/planned/detect` does — costs 4 000 rows on a path that `notify.draftBudgets` also walks on the
 * daily cron. Every group that contains no current-month charge cannot change a single figure
 * here, so the history is fetched only for merchants that can.
 *
 * ⚠️ **A charge linked to a plan is committed and is NOT offered to the rhythm detector.** The two
 * buckets must not overlap or the parts would stop summing to `spent`, and §PLAN-LINK is the
 * stronger evidence anyway: a declared plan is a decision the user made, a rhythm is a measurement.
 */
export async function envelopeParts(
  env: Env, mult: string, from: number, to: number, now: number,
): Promise<Map<number, EnvelopeParts>> {
  const since = now - RHYTHM_WINDOW_DAYS * 86400;
  // This month's spend, one row per operation, carrying the two facts the split turns on.
  // `EFF_AMOUNT`/`STATS_JOINS` so a split purchase lands in its parts' categories (§SPLIT).
  const monthRows = await env.DB.prepare(
    `SELECT ${EFF_CAT_ID} AS id, t.merchant AS merchant, t.planned_id AS planned_id,
            -${EFF_AMOUNT} * ${mult} AS amount
     FROM transactions t ${STATS_JOINS}
     WHERE t.time >= ? AND t.time <= ? AND ${SPEND_WHERE}`,
  ).bind(from, to).all<{ id: number | null; merchant: string | null; planned_id: number | null; amount: number }>();

  const rows = (monthRows.results ?? []).filter((r) => r.id != null);
  // The merchants whose rhythm is worth measuring: unlinked, named, and spending this month.
  const wanted = new Set<string>();
  for (const r of rows) if (r.planned_id == null && r.merchant) wanted.add(r.merchant);

  let rhythmic = new Set<string>();
  if (wanted.size) {
    const marks = [...wanted].map(() => "?").join(",");
    const hist = await env.DB.prepare(
      `SELECT t.merchant, -t.amount AS amount, t.time, t.currency_code,
              COALESCE(c.parent_id, t.category_id) AS category_id
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.amount < 0 AND t.is_transfer = 0 AND t.transfer_pair_id IS NULL
         AND t.time >= ? AND t.merchant IN (${marks})
         AND COALESCE(c.parent_id, t.category_id) IS NOT 13`,
    ).bind(since, ...wanted).all<ChargeRow>();
    // The detector groups by `coreToken`, so the ANSWER has to be read back through the same
    // token — `candidate.merchant` is the group's label, not a raw merchant string.
    for (const cand of recurringCandidates(hist.results ?? [], now)) {
      const k = coreToken(cand.merchant);
      if (k) rhythmic.add(k);
    }
  }

  const out = new Map<number, EnvelopeParts>();
  for (const r of rows) {
    const p = out.get(r.id!) ?? { committed: 0, rhythmic: 0, discretionary: 0 };
    const token = coreToken(r.merchant);
    if (r.planned_id != null) p.committed += r.amount;
    else if (token && rhythmic.has(token)) p.rhythmic += r.amount;
    else p.discretionary += r.amount;
    out.set(r.id!, p);
  }
  return out;
}


