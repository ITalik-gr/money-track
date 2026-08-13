// Ongoing refresh for banks that do not push (BANKS.md §5, step 6).
//
// monobank sends a webhook, so it needs none of this. PrivatBank has no push of any kind, which
// means without a poll an account gets history exactly when a human presses a button — and an app
// whose numbers are only right when you remember to refresh them is worse than one that says it
// cannot see the account at all.
//
// The shape follows the backfill's, deliberately, because §A6 already paid for these lessons:
//   • ONE account per pass. Sleeping between requests inside an alarm burns wall-clock time on a
//     billed invocation, and the alarm is a scheduler with other claimants (§A6).
//   • Pacing has its OWN timestamp. Living in the alarm's time means another job firing early
//     spends the request the bank only allows once per gap, and the sync quietly stalls.
//   • A window that OVERLAPS the last one. A bank posts an operation minutes to hours after it
//     happened, so asking only for "since the last poll" silently loses everything that landed
//     late — and nothing about the result looks wrong.
import type { Env } from "../../env.ts";
import { getState, setState } from "../finance/repo.ts";
import { upsertCanonicalTx } from "../../repo/ingest.ts";
import { recordSync } from "../../repo/connections.ts";
import { bankCredential } from "./credentials.ts";
import { getProvider } from "./providers/index.ts";

/** How often one account is refreshed. */
const POLL_INTERVAL_MS = 30 * 60_000;
/** How far back each poll reaches beyond the last one. See the note on late postings above. */
const OVERLAP_SEC = 6 * 60 * 60;
/** First poll of a fresh account: enough to catch up, short enough not to look like a backfill. */
const FIRST_WINDOW_SEC = 3 * 24 * 60 * 60;
const LAST_REQUEST_KEY = "poll_last_request_ms";
const accountKey = (id: string) => `poll_at_${id}`;

interface Pollable { id: string; provider: string; currency: number; lastMs: number }

/** Accounts whose bank must be asked rather than waited on, with when each was last asked. */
async function pollable(env: Env): Promise<Pollable[]> {
  const rows = await env.DB.prepare(
    "SELECT id, provider, currency_code FROM accounts WHERE is_manual = 0 AND is_active = 1",
  ).all<{ id: string; provider: string | null; currency_code: number | null }>();

  const out: Pollable[] = [];
  for (const a of rows.results ?? []) {
    const providerId = a.provider ?? "mono";
    const provider = getProvider(providerId);
    // `mode` is what decides this, not the presence of `statement`: monobank can be asked for a
    // statement (that is how the backfill works) but must not be polled — it pushes, and polling
    // it would spend its one-request-a-minute budget on data we already have.
    if (provider?.mode !== "poll" || !provider.statement) continue;
    if (!bankCredential(env, providerId)) continue;
    const last = await getState(env.DB, accountKey(a.id));
    out.push({ id: a.id, provider: providerId, currency: a.currency_code ?? 980, lastMs: Number(last ?? 0) });
  }
  return out;
}

/**
 * When the next poll is owed, in ms — or `null` when nothing needs polling at all.
 *
 * Read by `armAlarm`, which owns the object's single alarm and takes the earliest deadline among
 * every claimant. Returning `null` rather than a far-future time matters: a deadline nobody needs
 * would keep waking a paid isolate for an account that does not exist.
 */
export async function nextPollAt(env: Env): Promise<number | null> {
  const accounts = await pollable(env);
  if (!accounts.length) return null;

  const due = Math.min(...accounts.map((a) => a.lastMs + POLL_INTERVAL_MS));
  // The bank's own gap applies ACROSS accounts: two accounts at one bank share one credential and
  // therefore one rate limit.
  const gap = Math.max(
    ...accounts.map((a) => getProvider(a.provider)?.statement?.pacing.minGapMs ?? 60_000),
  );
  const lastRequest = Number((await getState(env.DB, LAST_REQUEST_KEY)) ?? 0);
  return Math.max(due, lastRequest + gap);
}

/**
 * Refreshes the ONE account that has waited longest, if it is due.
 *
 * Returns `null` when nothing was due — the alarm treats that as "re-arm and move on" rather than
 * as an error, because being early is normal when several claimants share one alarm.
 */
export async function pollOnce(env: Env): Promise<{ account: string; rows: number } | null> {
  const accounts = await pollable(env);
  if (!accounts.length) return null;

  const now = Date.now();
  const oldest = accounts.reduce((a, b) => (a.lastMs <= b.lastMs ? a : b));
  if (oldest.lastMs + POLL_INTERVAL_MS > now) return null;

  const provider = getProvider(oldest.provider)!;
  const credential = bankCredential(env, oldest.provider)!;
  const nowSec = Math.floor(now / 1000);
  const from = oldest.lastMs
    ? Math.floor(oldest.lastMs / 1000) - OVERLAP_SEC
    : nowSec - FIRST_WINDOW_SEC;

  // Stamped BEFORE the request, not after: a request that throws still consumed the bank's
  // allowance, and pacing that only counts successes is no pacing at all under a failure loop.
  await setState(env.DB, LAST_REQUEST_KEY, String(now));

  try {
    const txs = await provider.statement!.fetch(credential, oldest.id, from, nowSec, oldest.currency);
    for (const tx of txs) {
      // Same writer, same policy as the webhook and the backfill: a poll re-states operations we
      // already hold, including ones whose state has changed since (§INGEST-WRITE).
      await upsertCanonicalTx(env.DB, tx, { source: oldest.provider, onConflict: "refresh" });
    }
    await setState(env.DB, accountKey(oldest.id), String(now));
    await recordSync(env.DB, oldest.provider, provider.label, { ok: true });
    return { account: oldest.id, rows: txs.length };
  } catch (e) {
    if (provider.statement!.isRateLimit(e)) return null; // pause; the account stays due
    // ⚠️ The account IS marked as polled on a hard failure. Otherwise a permanently broken
    // credential makes this account "most overdue" forever, and every poll pass for every other
    // account is spent re-failing on this one. The failure is recorded on the connection, which
    // is where a person can see it (BANKS.md §5, step 4).
    await setState(env.DB, accountKey(oldest.id), String(now));
    await recordSync(env.DB, oldest.provider, provider.label, {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
