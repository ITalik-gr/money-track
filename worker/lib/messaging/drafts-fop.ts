/**
 * `drafts-fop` — the notifications that only exist for a SOLE TRADER (docs/TAX.md).
 *
 * Split from `drafts-due.ts` on 2026-09-18, and the reason is a claim that had quietly become
 * false. That file's own header says «every draft here answers ‹money leaves on a date you did not
 * choose›» — true of a subscription charge and a card payment, and not true of «an official page
 * changed» or «a client stopped paying». Three drafters had accumulated there because the ФОП work
 * landed while `drafts-due` was the newest file, not because they belonged.
 *
 * What they share is a real precondition rather than a shape: **all three answer with nothing
 * while the ФОП module is off** — the tax deadlines and the quiet-client watch check the profile
 * outright, and the regulatory sources are only ever added by somebody using it. A person who does
 * not run a business should never see any of this, and keeping that in one file is what makes the
 * rule checkable at a glance.
 *
 * ⚠️ They keep SEPARATE preferences (`deadline`, `regulation`, `quiet_client`). Muting «money is
 * due» says nothing about wanting to hear that a rule moved, and neither says anything about
 * wanting to hear that the business is shrinking — the same argument §TAX-WATCH made for its own
 * kind when it was added.
 *
 * ⚠️ §TAX-UAH: the tax drafter prints HRYVNIA while the sibling file prints the reader's base
 * currency (§CUR-PLAN, §BASE-CUR). Not an inconsistency — the state levies in hryvnia, and a tax
 * figure converted into a display base appears on no document.
 */
import type { Env } from "../../env.ts";
import { localYmd } from "../finance/stats.ts";
import { readProfile, refreshObligations, quarterWindow } from "../finance/tax.ts";
import * as taxRepo from "../../repo/tax.ts";
import { listSources } from "../finance/tax-watch.ts";
import { quietClients } from "../finance/business.ts";
import type { Draft } from "./notify.ts";

/**
 * §TAX-DUE — an accrued tax that has not been paid, inside the horizon.
 *
 * Fourteen days rather than the three the subscriptions use: a card charge needs a balance on the
 * day, a tax payment often needs the money to be moved out of a business account first, and an
 * alert that lands the evening before is an alert about something that can no longer be arranged.
 *
 * ⚠️ Overdue rows are reported too, and louder. A missed subscription retries; a missed tax
 * deadline accrues a penalty and keeps accruing, so «this was due four days ago» is the single
 * most useful sentence this feed can produce.
 */
export async function draftTaxDue(env: Env, now: number): Promise<Draft[]> {
  const profile = await readProfile(env.DB);
  if (!profile.enabled) return [];
  await refreshObligations(env.DB, now);

  const today = localYmd(now);
  const out: Draft[] = [];
  // ⚠️ From the PREVIOUS year, not from January of this one — the same window `taxStatus` reads.
  // `period >= '2026'` sorts '2025-Q4' out, and 2025-Q4 is the single most forgettable payment in
  // the calendar: ЄП and ВЗ are due on 19 February and ЄСВ was due on 19 January, both for a
  // quarter that is already closed and filed away. On 10 February a group-3 payer with a full Q4
  // got an EMPTY deadline feed (A3 audit, 2026-09-18). The 14-day horizon below still bounds the
  // noise, and a permanently unique `dedup_key` means each period is announced once ever.
  for (const o of await taxRepo.listObligations(env.DB, `${Number(today.slice(0, 4)) - 1}-01`)) {
    if (o.paid_tx_id || o.amount <= 0) continue;
    const days = Math.round(
      (Date.parse(`${o.due_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
    );
    if (days > 14) continue;
    // ⚠️ THE MOST FORGOTTEN PAYMENT IN THE CALENDAR: ЄСВ in a quarter with no income at all.
    // «I earned nothing, so I owe nothing» is true of the single tax on group 3 and false of the
    // contribution, which is a flat monthly figure in every group (docs/TAX.md §3). The reminder
    // that does not say so is the one that gets dismissed, so the quiet quarter gets its own
    // sentence rather than the same line with a different number.
    const quiet = o.kind === "social_contribution" && o.period.includes("Q")
      ? (await (async () => {
          const w = quarterWindow(o.period);
          return (await taxRepo.businessIncome(env.DB, w.from, w.to)).base_uah === 0;
        })())
      : false;
    out.push({
      kind: "deadline",
      tkey: quiet ? "deadline_tax_quiet" : "deadline_tax",
      tparams: { title: TAX_TITLE[o.kind] ?? o.kind, days, amount: o.amount, due: o.due_date, period: o.period },
      severity: days < 0 ? "urgent" : "warn",
      entity_type: "tax_obligation", entity_id: String(o.id),
      // The period, not the date: re-announcing the same quarter every day would bury it, and the
      // amount still moves while the quarter is open.
      dedup_key: `deadline:tax:${o.kind}:${o.period}:${days < 0 ? "overdue" : "due"}`,
    });
  }
  return out;
}

/** Names as the payment order calls them; not translated — they label a document, not prose. */
const TAX_TITLE: Record<string, string> = {
  single_tax: "Єдиний податок",
  military_levy: "Військовий збір",
  social_contribution: "ЄСВ",
};

/**
 * A client who used to pay on a rhythm and has stopped.
 *
 * ⚠️ ONE event per client per month of silence, not per day. `dedup_key` carries the month, so a
 * client who has been quiet for a quarter is announced three times in three months rather than
 * ninety times — and each of those three is a genuinely new statement, because the silence got
 * longer. A key with the exact day in it would be the same sentence every morning, which is how
 * a feed teaches people to stop reading it.
 *
 * ⚠️ `warn`, never `urgent`. A client may have paused for a reason the app cannot see — a holiday,
 * a project between phases, an invoice not yet sent. The app is reporting a rhythm that broke, not
 * asserting that something is wrong.
 */
export async function draftQuietClients(env: Env, now: number): Promise<Draft[]> {
  const profile = await readProfile(env.DB);
  if (!profile.enabled) return [];
  const month = localYmd(now).slice(0, 7);
  return (await quietClients(env.DB, now)).slice(0, 3).map((c) => ({
    kind: "quiet_client" as const,
    tkey: "quiet_client" as const,
    tparams: { name: c.name, days: c.days_since_last, gap: c.median_gap_days, amount: c.avg_uah, n: c.n },
    severity: "warn" as const,
    entity_type: "merchant", entity_id: c.name,
    dedup_key: `quiet:${c.name}:${month}`,
  }));
}

/**
 * §TAX-WATCH — an official source moved.
 *
 * ⚠️ Says ONLY that the page changed, and links it. It never states what the page now says: the
 * thing being watched is a payment requisite, and an app that restates one it has not been told by
 * a human is doing the exact harm the watch exists to prevent (docs/TAX.md §0.2).
 *
 * The check itself is the cron's job, not this drafter's — this reads the flags the watcher left.
 */
export async function draftRegulation(env: Env, now: number): Promise<Draft[]> {
  const out: Draft[] = [];
  for (const s of await listSources(env.DB)) {
    // A noisy source is one that changes whenever its footer does. It keeps recording, and stops
    // speaking, until a person clears the flag — an alert that arrives daily is one nobody reads,
    // and then the real change goes out with the rest of the noise.
    if (s.noisy || !s.last_changed) continue;
    if (now - s.last_changed > 14 * 86_400) continue;
    out.push({
      kind: "regulation",
      tkey: "regulation",
      tparams: { title: s.label },
      severity: s.topic === "requisites" ? "urgent" : "warn",
      entity_type: "reg_source", entity_id: String(s.id),
      dedup_key: `regulation:${s.id}:${s.last_changed}`,
    });
  }
  return out;
}
