// Which credential feeds a given provider, for THIS user (BANKS.md §5, step 5).
//
// Before this, four places read `env.MONO_TOKEN` by name — the two setup routes, the backfill and
// the credentials screen — which is fine while there is one bank and becomes a rewrite the moment
// there are two. The point of the function is not indirection: it is that there is now exactly
// ONE place where "where does a bank credential come from" is answered, and therefore exactly one
// place where the rule below can be broken.
//
// ⚠️ **A deployment-wide secret is the OWNER'S, never a fallback for everybody.** This project
// shipped that bug twice (§Безпека): with a global `MONO_TOKEN` as everyone's fallback, an invited
// user pressing "sync accounts" pulled the OWNER'S statement into their own database. The gate
// already exists and lives in `UserDO.userCredentials`, which hands the object an `env.MONO_TOKEN`
// that is either this user's own decrypted token or — for the owner alone — the deployment secret.
// So this function reads what the object was GIVEN and never reaches for a global itself.
//
// ⚠️ **A new provider gets NO deployment fallback at all**, owner included: there is no
// single-user history to stay compatible with, and the owner's own key belongs in `user_secrets`
// like everyone else's. Add the line here, not a new global binding.
import type { Env } from "../../env.ts";

/** The credential, or `null` when this user has not linked this bank. */
export function bankCredential(env: Env, providerId: string): string | null {
  const fromRecord = env.BANK_CREDENTIALS?.[providerId];
  if (fromRecord) return fromRecord;
  // monobank predates the record and is still injected under its own name by every entry point
  // that builds an `Env` (the credentials screen reads it too). Kept so an env assembled without
  // the record cannot silently stop syncing the one bank that already works.
  if (providerId === "mono" && env.MONO_TOKEN) return env.MONO_TOKEN;
  return null;
}
