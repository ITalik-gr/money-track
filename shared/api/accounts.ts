// Response shapes of `/api/accounts/*`, `/api/summary` and `/api/rates`.
// Money is INTEGER minor units. See `./analytics.ts` for why this file exists.
import type { NetWorthSummary } from "../types.ts";

/**
 * `GET /summary` — own funds per currency plus the credit-card breakdown.
 *
 * The client used to declare this as its own `Summary` interface while `shared/types.ts` already
 * had `NetWorthSummary` with the identical shape — the D2 defect in miniature: two names for one
 * contract, neither of them imported by the worker. The alias keeps the client's spelling working.
 */
export type Summary = NetWorthSummary;

// §R3: розбивка коштів (₴-мінор). cushion/debt/investment/net — канон fundsBreakdown (= Порадник).
export interface AccountFunds { title: string | null; type: string | null; role: "liquid" | "investment"; own_uah: number; note: string | null }
export interface FundsBreakdown { cushion: number; debt: number; investment: number; net: number; accounts: AccountFunds[] }

/** `GET /accounts/history` — per-account monthly balance, in the ACCOUNT's currency, MAJOR units. */
export interface AccountHistory { history: Record<string, number[]> }

/**
 * `GET /setup/connections` — one row per linked bank credential (BANKS.md §5, step 4).
 *
 * `last_sync_at` survives a failure on purpose: "last worked at 09:00, failing since" is the
 * fact worth reading, and blanking it would turn a broken connection into one that never ran.
 */
export interface BankConnection {
  id: string;
  provider: string;
  label: string | null;
  status: string;
  last_sync_at: number | null;
  last_error: string | null;
  accounts: number;
}
export interface BankConnections { connections: BankConnection[] }
