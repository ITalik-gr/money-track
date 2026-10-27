/**
 * §TAX-UNLINKED — «not linked» is not «not paid», for taxes as for plans (§PLAN-LATE).
 *
 * `paid_tx_id` is a link a human makes (§TAX-DUE), and until they make it every obligation reads
 * as unpaid. On the owner's data (2026-10-27) that turned two settled ЄСВ quarters — 5 707 ₴ paid
 * on 7 April and on 1 July, to the hryvnia — into «next payment: 19 April, 191 days overdue» and a
 * reserve of 22 828 ₴ where 11 414 ₴ was owed. Worse, the one quarter that WAS unpaid (Q3, due
 * 19 October) sat behind the April row, so the feed's loudest line was false and the true one
 * never reached the header.
 *
 * So an unpaid obligation with an operation of the SAME amount near its deadline is «likely paid»:
 *   • it leaves the reserve — that money has already left the account, and keeping it reserved
 *     subtracts it from free money a second time;
 *   • it is neither `next` nor overdue, and the feed does not announce it;
 *   • it is NOT linked. The link stays a person's click (the candidate is shown for it), because an
 *     automatic link would be the app asserting a payment it cannot verify.
 *
 * ⚠️ Exact amount (1 %), not `paymentCandidates`' 10 % window: that window is for a human picking
 * from a list; this one decides silently, so only the figure the accrual itself names counts.
 * ⚠️ Earliest deadline first, and each operation answers one obligation, or the April payment
 * would settle April AND July.
 */
import type { AppDb } from "../platform/db-shim.ts";
import * as taxRepo from "../../repo/tax.ts";

export async function likelyPaid(
  db: AppDb, obligations: { id: number; amount: number; due_date: string; paid_tx_id: string | null }[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const used = new Set<string>();
  const open = obligations.filter((o) => !o.paid_tx_id && o.amount > 0)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  for (const o of open) {
    const cands = await taxRepo.paymentCandidates(db, o.amount, o.due_date);
    const hit = cands.find((c) => !used.has(c.id) && Math.abs(-c.amount - o.amount) <= Math.max(100, o.amount * 0.01));
    if (hit) { out.set(o.id, hit.id); used.add(hit.id); }
  }
  return out;
}
