import type { KnowledgeDoc } from "./types.ts";

// Інвестиції та крипта — база для порад. Загальні принципи, НЕ інвест-рекомендації під конкретні
// активи. Завжди наголошуй на ризику й що рішення — за користувачем.
export const investing: KnowledgeDoc = {
  id: "investing",
  title: "Інвестиції та крипта (база)",
  summary: "Роль інвест-резерву, горизонт і ризик, диверсифікація, DCA, крипта, складний відсоток.",
  titleEn: "Investing and crypto (basics)",
  summaryEn: "Role of the investment reserve, horizon and risk, diversification, DCA, crypto, compounding.",
  body: `
These are general principles, not "buy or sell this asset" advice. The decision is always the user's; state the risk.

### The role of the investment reserve in this app
- The investment reserve (crypto, brokerage) is NOT the emergency fund and does NOT count toward runway. It is the last line of defence for an extreme case.
- Do not suggest touching it to cover current spending unless the situation is critical: selling into a drawdown locks in the loss, and taxes and fees may apply on top.

### Horizon and risk
- Only "long" money — money not needed for 5+ years — belongs in investments. The emergency fund and money for near-term goals do not: they need liquidity and stability.
- Higher expected return means higher risk and volatility. There is no "risk-free high return"; anyone promising one is a red flag for fraud.
- Expensive debt first, investing second: clearing a credit card at 30–50% a year is a guaranteed "return" the market cannot reliably match.

### Diversification
- Do not hold everything in one asset, sector or currency. Broad diversification lowers risk without a proportional loss of expected return.
- Concentration risk is especially dangerous in a single volatile asset (one stock, one token).

### DCA versus timing the market
- Regular fixed-size contributions (dollar-cost averaging) smooth the entry price and remove the attempt to "catch the bottom". Systematic market timing loses for most people.
- "Time in the market beats timing the market": compounding works over long horizons, and the earliest contributions do the most work.

### Crypto — treated separately (elevated risk)
- Very high volatility: 50–80% drawdowns are historically normal. Hold only a small share of the portfolio — as much as the user could lose entirely without it damaging their life.
- Security: cold storage for meaningful amounts, caution with exchanges (bankruptcy and hack risk), protect the seed phrase, enable 2FA. "Not your keys, not your coins."
- Never borrow or pledge assets to buy crypto. Never "put in the last of it" on emotion.
- Stablecoins are not risk-free: issuer risk and de-pegging are real.

### Psychology
- An investor's main enemies are fear and greed: panic-selling a drawdown and FOMO-buying a peak. A plan and DCA impose discipline.
- Do not check the portfolio daily — it provokes impulsive decisions.

### Taxes (in general)
- Investment income is usually taxable (profitable sales, dividends, crypto). Specific rates and rules depend on jurisdiction and year — verify exact figures against an official source rather than from memory.
`.trim(),
};
