// Bank provider abstraction (PLATFORM.md §5).
//
// The rule this exists to enforce: sign, currency and minor-units normalisation happen in
// exactly ONE place per provider — `normalizeTx` — and everything downstream sees the canonical
// shape described in CLAUDE.md §Інваріанти (integer kopecks, `currency_code` = the ACCOUNT's
// currency, `original_amount`/`original_currency` for the operation's own currency).
//
// Why that matters more than the usual "nice interface" argument: every currency bug this
// project has had came from a second place deciding what a number meant. A provider that
// normalises in its fetch path and again in its webhook path will eventually disagree with
// itself, and the disagreement shows up months later as money that does not add up.
import type { AppDb } from "../../platform/db-shim.ts";

/** Canonical account, provider-agnostic. Mirrors the `accounts` table. */
export interface CanonicalAccount {
  id: string;
  type: string | null;
  title: string | null;
  currency_code: number | null;
  balance: number | null;
  credit_limit: number | null;
  iban?: string | null;
}

/** Canonical transaction, provider-agnostic. Mirrors the columns `repo.upsertMonoTx` writes. */
export interface CanonicalTx {
  id: string;
  account_id: string;
  time: number;
  /** Minor units, negative for spending, in the ACCOUNT's currency. */
  amount: number;
  currency_code: number;
  /** Set only when the operation's own currency differs from the account's. */
  original_amount?: number | null;
  original_currency?: number | null;
  mcc?: number | null;
  description?: string | null;
  comment?: string | null;
  balance_after?: number | null;
  cashback?: number | null;
  hold?: boolean;
  /**
   * The provider's own payload, stored verbatim in `raw_json`.
   *
   * Part of the canonical shape rather than a writer option because it is a COLUMN, and because
   * it is the only thing that can answer "what did the bank actually send" months later — a
   * normalisation bug is otherwise indistinguishable from a bank that reported something odd.
   */
  raw?: unknown;
}

/**
 * How fresh transactions reach us.
 *   webhook — the bank pushes (monobank)
 *   poll    — we pull on a timer (PrivatBank has no reliable push)
 *   manual  — a human supplies the data (CSV import, hand-entered cash)
 */
export type ProviderMode = "webhook" | "poll" | "manual";

/**
 * How a bank must be ASKED for history — the numbers the paced backfill obeys.
 *
 * These belong to the bank, not to the backfill. Until 2026-08-13 they were monobank's constants
 * written into `backfill.ts` (a 31-day window, a 60-second gap, a `MonoRateLimit` catch), which
 * made "the backfill" in fact "monobank's backfill". A second provider with different numbers
 * would have had to either fork the loop or quietly break its own bank's limits — and exceeding
 * them does not fail loudly, it just stalls the sync.
 */
export interface StatementPacing {
  /** Longest window the bank accepts in ONE request, in seconds. */
  maxWindowSec: number;
  /** Minimum gap between two statement requests on one credential, in ms. */
  minGapMs: number;
}

/**
 * The paced history fetch, as ONE capability: pacing, the request, and "was that the bank saying
 * slow down". All three or none — a provider that can be asked for history but cannot recognise
 * its own rate-limit answer will spend the retry budget on an error it could have named.
 */
export interface StatementFetch {
  pacing: StatementPacing;
  /**
   * One statement request, already canonical.
   *
   * `accountCurrency` is passed IN rather than looked up: normalisation is the provider's one
   * job and it needs the account's currency to decide `original_*` (§R2-CUR1), but a provider
   * that reaches for the database stops being a pure adapter over someone's HTTP API.
   */
  fetch(
    credential: string,
    accountId: string,
    from: number,
    to: number,
    accountCurrency: number,
  ): Promise<CanonicalTx[]>;
  /** Only the provider knows the shape of its own "too many requests". */
  isRateLimit(e: unknown): boolean;
}

export interface BankProvider {
  id: string;
  /** Shown in the UI when linking a connection. */
  label: string;
  mode: ProviderMode;
  /** Accounts available under this credential, already canonical. */
  listAccounts?(credential: string): Promise<CanonicalAccount[]>;
  /** Writes those accounts into the database. Separate from `listAccounts` so a UI can preview. */
  syncAccounts?(db: AppDb, credential: string): Promise<{ accounts: number; jars: number }>;
  /** Points the bank at our per-user webhook URL. */
  registerWebhook?(credential: string, url: string): Promise<void>;
  /** Paced history. Absent means this provider has no history to fetch (a file, cash). */
  statement?: StatementFetch;
  /** Pulls anything new since `since` (poll providers). */
  poll?(credential: string, accountId: string, since: number): Promise<CanonicalTx[]>;
}

const registry = new Map<string, BankProvider>();

export function registerProvider(p: BankProvider): void {
  registry.set(p.id, p);
}

/** `null` for an unknown id — callers decide whether that is an error or simply "not linked". */
export function getProvider(id: string | null | undefined): BankProvider | null {
  return id ? (registry.get(id) ?? null) : null;
}

export function listProviders(): BankProvider[] {
  return [...registry.values()];
}
