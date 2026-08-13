// "You have not imported a statement in a while" (2026-08-13).
//
// Some banks have no API for personal accounts — Raiffeisen and PrivatBank both closed that door
// (BANKS.md §1, §5.2) — so those accounts are a file the owner exports by hand, forever. A monthly
// chore with no reminder is a chore that gets skipped, and the failure is invisible in the worst
// way: the app does not look broken, it looks like a month where you barely spent anything. Every
// number downstream (burn, runway, budgets, the advisor) then quietly describes a life that did
// not happen.
//
// Filed under the `todo` KIND rather than a new one, and that is deliberate: it is the same
// concern as "10 operations have no category" — the app asking a person to finish something only
// they can finish — so one preference should mute both. A separate kind would let someone silence
// the categorisation nag and keep being reminded about files, which nobody wants.
import type { Env } from "../../env.ts";
import { localYm } from "../finance/stats.ts";
import type { Draft } from "./notify.ts";

/** A month plus slack. Shorter nags someone whose bank posts the statement late. */
const STALE_DAYS = 35;
/** Three is the point where a list stops being a reminder and becomes a wall. */
const MAX_ACCOUNTS = 3;

export async function draftStaleImports(env: Env, now: number): Promise<Draft[]> {
  const rows = await env.DB.prepare(
    // Only accounts that are FED BY FILE and by nothing else. `provider` naming a bank we can
    // fetch from means fresh rows arrive on their own, and a nudge there would be the app asking
    // for work it is already doing itself.
    `SELECT a.id, a.title, a.type, MAX(t.time) AS last_time
       FROM accounts a
       JOIN transactions t ON t.account_id = a.id AND t.source = 'import'
      WHERE a.is_active = 1
        AND a.provider NOT IN ('mono', 'privat')
      GROUP BY a.id
      HAVING last_time < ?
      ORDER BY last_time ASC
      LIMIT ?`,
  )
    .bind(now - STALE_DAYS * 86400, MAX_ACCOUNTS)
    .all<{ id: string; title: string | null; type: string | null; last_time: number }>();

  return (rows.results ?? []).map((a) => ({
    kind: "todo" as const,
    tkey: "stale_import" as const,
    tparams: {
      account: a.title ?? a.type ?? a.id,
      days: Math.floor((now - a.last_time) / 86400),
    },
    severity: "info" as const,
    // Not `account` (that routes to the accounts list, where nothing can be done about it) — the
    // event's own screen is the import card, and a notification that leaves the reader hunting
    // for the right screen makes them do the work the feed exists to do.
    entity_type: "import",
    entity_id: a.id,
    // One nudge per account per Kyiv month (§APP_TZ): the chore itself is monthly, so a weekly
    // repeat would be the app arguing with a person who already knows.
    dedup_key: `stale_import:${a.id}:${localYm(now)}`,
  }));
}
