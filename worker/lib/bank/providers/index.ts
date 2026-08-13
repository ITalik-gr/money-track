// Provider registry wiring. Importing this module registers every known provider, so callers
// only ever ask `getProvider(account.provider)` and never name a bank directly.
import { registerProvider } from "./provider.ts";
import { monoProvider } from "./mono.ts";
import { csvProvider } from "./csv.ts";
import { privatProvider } from "./privat.ts";
import { manualProvider } from "./manual.ts";

registerProvider(monoProvider);
registerProvider(privatProvider);
registerProvider(csvProvider);
registerProvider(manualProvider);

export { getProvider, listProviders, type BankProvider, type CanonicalAccount, type CanonicalTx } from "./provider.ts";
