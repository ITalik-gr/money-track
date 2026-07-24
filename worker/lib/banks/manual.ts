// Hand-kept accounts: cash, crypto, a card at a bank we do not integrate with.
//
// It has no fetch path at all, and that is the point — registering it means `getProvider()`
// always returns something, so callers never need a "…or it's manual" special case beside every
// provider lookup. Those special cases are how a manual account eventually gets handed to a
// bank API and has its hand-entered balance overwritten.
import type { BankProvider } from "./provider.ts";

export const manualProvider: BankProvider = {
  id: "manual",
  label: "Вручну",
  mode: "manual",
};
