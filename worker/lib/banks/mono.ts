// monobank as a `BankProvider`. A thin adapter over the existing client — the HTTP details,
// the rate-limit error and the statement shape all stay in `lib/mono.ts`, which has been in
// production long enough to be worth not disturbing.
import type { BankProvider, CanonicalAccount } from "./provider.ts";
import type { AppDb } from "../db-shim.ts";
import { getClientInfo, setWebhook } from "../mono.ts";
import { syncAccounts as writeAccounts } from "../repo.ts";

export const monoProvider: BankProvider = {
  id: "mono",
  label: "Monobank",
  mode: "webhook",

  async listAccounts(token: string): Promise<CanonicalAccount[]> {
    const info = await getClientInfo(token);
    const cards: CanonicalAccount[] = info.accounts.map((a) => ({
      id: a.id,
      type: a.type,
      title: a.type,
      currency_code: a.currencyCode,
      balance: a.balance,
      credit_limit: a.creditLimit,
      iban: a.iban ?? null,
    }));
    const jars: CanonicalAccount[] = (info.jars ?? []).map((j) => ({
      id: j.id,
      type: "jar",
      title: j.title,
      currency_code: j.currencyCode,
      balance: j.balance,
      credit_limit: 0,
    }));
    return [...cards, ...jars];
  },

  async syncAccounts(db: AppDb, token: string) {
    // Delegates to `repo.syncAccounts` rather than writing here, because that function carries
    // rules this adapter must not re-decide — notably that a jar's title is written only on
    // first insert, so a hand-renamed jar survives the next sync (mono returns a generic "БАНКА").
    const info = await getClientInfo(token);
    await writeAccounts(db, info);
    await db
      .prepare("UPDATE accounts SET provider = 'mono' WHERE is_manual = 0 AND provider IS NOT 'mono'")
      .run();
    return { accounts: info.accounts.length, jars: info.jars?.length ?? 0 };
  },

  async registerWebhook(token: string, url: string) {
    await setWebhook(token, url);
  },
};
