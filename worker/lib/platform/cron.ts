// Scheduled work in the multi-user world.
//
// The split, and why it is not "all alarms" as first sketched in PLATFORM.md §2:
//
//   • Daily / weekly / monthly jobs — Worker cron fans out to each user's Durable Object.
//     A Durable Object can hold exactly ONE pending alarm, so self-scheduling three different
//     cadences from inside means writing a small scheduler in every object. For ~10-50 users
//     one daily pass is nothing, and a fan-out is far easier to reason about and to observe.
//
//   • Backfill pacing — stays an alarm inside the object. That one is genuinely per-user and
//     ticks every 60 seconds; running it as a global minute-cron would wake EVERY object every
//     minute just to discover there is nothing to do.
//
// Rates are fetched once for everybody (see migrations-directory/0002_shared_state.sql).
import type { Env } from "../../env.ts";

const RATES_KEY = "rates";

/** Fetches monobank's public rates and stores them where every user's object can read them. */
export async function refreshSharedRates(env: Env): Promise<number> {
  const { getCurrencyRates } = await import("../bank/mono.ts");
  const rates = await getCurrencyRates();
  const map: Record<string, number> = {};
  for (const r of rates) {
    if (r.currencyCodeB === 980 && (r.rateSell || r.rateCross)) {
      map[String(r.currencyCodeA)] = (r.rateSell ?? r.rateCross)!;
    }
  }
  await env.DIRECTORY.prepare(
    `INSERT INTO shared_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(RATES_KEY, JSON.stringify(map), Math.floor(Date.now() / 1000))
    .run();
  return Object.keys(map).length;
}

/** Reads the shared rates. `null` when the cron has not run yet or the table is missing. */
export async function readSharedRates(env: Env): Promise<string | null> {
  try {
    const row = await env.DIRECTORY.prepare("SELECT value FROM shared_state WHERE key = ?")
      .bind(RATES_KEY)
      .first<{ value: string }>();
    return row?.value ?? null;
  } catch {
    // The directory migration may not be applied yet. Degrading to "no shared rates" keeps a
    // working deployment working — the DO simply keeps whatever rates it already had.
    return null;
  }
}
