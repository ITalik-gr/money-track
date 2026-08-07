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
