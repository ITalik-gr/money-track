// §Інваріанти — "own funds", the one formula that decides how much money is actually YOURS.
//
// A credit card's `balance` is spendable money, not owned money: it includes the bank's limit.
// So own funds are `balance − credit_limit`, and a card in debt yields a NEGATIVE number, which
// it must keep (owner's decision, 2026-08-03). The client used to clamp it at zero, so the
// Accounts page total and the dashboard cushion disagreed for the same card — the clamp is gone,
// and this module is what stops the next copy from re-introducing a variant.
//
// It was four separate expressions before phase 4 (`computeSummary`, `fundsBreakdown`, and twice
// in the net-worth reconstruction). They all agreed, which is luck rather than design: nothing
// compared them, and the fifth copy is where a project like this loses an evening.

/** Own funds in the ACCOUNT's currency, minor units. Negative when a credit card is in debt. */
export function ownFundsMinor(
  balance: number | null | undefined,
  creditLimit: number | null | undefined,
): number {
  return (balance ?? 0) - (creditLimit ?? 0);
}

/**
 * Debt on a card, as a POSITIVE number; 0 when nothing is owed.
 *
 * Debt is not an independent quantity — it is own funds seen from the other side. Deriving it
 * here rather than writing `credit_limit − balance` again is the point: a second expression for
 * one number is exactly what the register (D1) recorded as an "inverted copy", when in fact it
 * was this — a different question, correctly answered, that merely LOOKED like a contradiction.
 */
export function debtMinor(
  balance: number | null | undefined,
  creditLimit: number | null | undefined,
): number {
  const own = ownFundsMinor(balance, creditLimit);
  return own < 0 ? -own : 0;
}
