// PrivatBank as a `BankProvider` — poll mode, because AutoClient has no push of any kind.
//
// Scope, stated where someone will read it: this is the ФОП / legal-entity settlement account.
// Personal Privat cards have had no API since 2023 and go through the CSV importer (BANKS.md §1).
import type { BankProvider, CanonicalAccount } from "./provider.ts";
import type { AppDb } from "../../platform/db-shim.ts";
import {
  assertWorking, listBalances, listTransactions, privatToAccount, privatToCanonical,
  PrivatUnavailable, type PrivatCredential,
} from "../privat.ts";
import { upsertProviderAccounts } from "../../../repo/accounts.ts";

/**
 * The credential is ONE opaque string to everything except this file — that is what lets
 * `bankCredential()` stay `(env, id) => string | null` while banks disagree about how many values
 * a login needs. Privat wants two (a client id and a token), so it stores JSON.
 */
export function parseCredential(raw: string): PrivatCredential {
  try {
    const parsed = JSON.parse(raw) as Partial<PrivatCredential>;
    if (parsed?.token) return { id: parsed.id?.trim() || undefined, token: parsed.token.trim() };
  } catch {
    // Not JSON: a bare token, which is what a single-client integration actually needs. Accepting
    // it means someone who pasted just the token gets a working connection instead of a parse
    // error about a format they were never shown.
  }
  const token = raw.trim();
  if (!token) throw new Error("privat: empty credential");
  return { token };
}

const DAY = 24 * 60 * 60;

export const privatProvider: BankProvider = {
  id: "privat",
  label: "PrivatBank (ФОП)",
  mode: "poll",

  async listAccounts(credential: string): Promise<CanonicalAccount[]> {
    const cred = parseCredential(credential);
    const balances = await listBalances(cred, Math.floor(Date.now() / 1000));
    return balances.map(privatToAccount).filter((a): a is CanonicalAccount => a !== null);
  },

  async syncAccounts(db: AppDb, credential: string) {
    const accounts = await this.listAccounts!(credential);
    await upsertProviderAccounts(db, "privat", accounts);
    // No jars at a business bank; the count is part of the shared contract, so it is stated
    // rather than left undefined.
    return { accounts: accounts.length, jars: 0 };
  },

  statement: {
    pacing: {
      // The API takes DATES, not timestamps, so a window shorter than a day buys nothing. 30 days
      // is well inside what the endpoint accepts and keeps one request's page count sane.
      maxWindowSec: 30 * DAY,
      // ⚠️ PrivatBank documents NO rate limit, which is not the same as having none. Five seconds
      // is deliberately conservative: an undocumented limit is discovered in production, and the
      // cost of being slow here is a backfill that takes a minute longer.
      minGapMs: 5_000,
    },
    async fetch(credential, accountId, from, to, accountCurrency) {
      const cred = parseCredential(credential);
      // The phase check first: during maintenance the transaction endpoint answers with errors,
      // and one cheap call turns that into a pause instead of a lost window.
      await assertWorking(cred);
      // The account id is namespaced on our side (`pb_<IBAN>`); the bank knows only the IBAN.
      const bankAccount = accountId.startsWith("pb_") ? accountId.slice(3) : accountId;
      const rows = await listTransactions(cred, bankAccount, from, to);
      return rows
        .map((t) => privatToCanonical(t, accountId, accountCurrency))
        .filter((t): t is NonNullable<typeof t> => t !== null);
    },
    isRateLimit: (e) => e instanceof PrivatUnavailable,
  },
};
