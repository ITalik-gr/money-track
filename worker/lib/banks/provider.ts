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
import type { AppDb } from "../db-shim.ts";

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
}

/**
 * How fresh transactions reach us.
 *   webhook — the bank pushes (monobank)
 *   poll    — we pull on a timer (PrivatBank has no reliable push)
 *   manual  — a human supplies the data (CSV import, hand-entered cash)
 */
export type ProviderMode = "webhook" | "poll" | "manual";

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
