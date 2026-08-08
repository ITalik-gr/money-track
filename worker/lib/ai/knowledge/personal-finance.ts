import type { KnowledgeDoc } from "./types.ts";

// Принципи особистих фінансів — стабільний довідник для AI-порадника (вбудований корпус, §A5).
// Це ЗАГАЛЬНІ знання/фреймворк, НЕ дані користувача. Персональні числа завжди беруться з контексту.
export const personalFinance: KnowledgeDoc = {
  id: "personal-finance",
  title: "Принципи особистих фінансів",
  summary: "Подушка, runway, пріоритети грошей, погашення боргу, норма заощаджень, sinking funds.",
  titleEn: "Personal finance principles",
  summaryEn: "Emergency fund, runway, money priorities, debt payoff, savings rate, sinking funds.",
  body: `
### Emergency fund
- A liquid reserve for the unexpected (lost income, repairs, health). Keep it LIQUID (cash, cards, jars) — not in investments or crypto.
- Target size: 3–6 months of basic expenses on a stable income; **6–12 months on an unstable or irregular income** (freelance, sole proprietor, seasonal work), because the income gaps run deeper.
- "Basic expenses" means the obligatory ones (housing, food, utilities, transport, communications, minimum payments), not the whole lifestyle. Size the fund against those, not against the most expensive months.

### Runway
- runway = liquid emergency fund ÷ average monthly spend (burn). It says how many months the user lasts with no income at the current pace.
- Reference points: <3 months is alarming — priority number one is growing the fund and cutting the optional; 3–6 months is acceptable; >6 months is comfortable and the surplus can go to goals or investments.
- Runway is measured from the LIQUID fund. Credit-card debt and the investment reserve enter neither the numerator nor the denominator.

### Money priority waterfall
Where free money goes, in order:
1. Cover the month's basic expenses.
2. A mini-fund of about one month, so small surprises do not turn into debt.
3. **Pay off expensive debt** (credit cards, high-rate consumer loans) — a guaranteed "return" equal to the debt's rate.
4. The full emergency fund (3–12 months depending on the situation).
5. Medium-term goals (a large purchase, a trip) through sinking funds.
6. Long-term investing.
Do not skip levels without a reason: investing while carrying credit-card debt at 30–50% a year is almost always a loss.

### Paying off debt
- **Avalanche**: pay the highest interest rate first — mathematically optimal, least total interest.
- **Snowball**: pay the smallest balance first — worse mathematically, but it delivers psychological wins and keeps momentum.
- A credit limit or credit card is usually the most expensive debt, so it comes first. The minimum payment is mostly interest, and barely touches the principal.

### Savings rate and budgeting
- Savings rate = (income − spending) ÷ income. Aim for 20%+, more for aggressive goals. Early on this matters more for wealth than investment returns do.
- The 50/30/20 guide: ~50% needs, ~30% wants, ~20% savings and debt. A starting point, not a rule — adapt it to reality.
- **Pay yourself first**: move the planned amount aside IMMEDIATELY when income arrives, rather than "whatever is left at the end of the month" (usually nothing is).

### Sinking funds
- For annual, quarterly or seasonal costs (insurance, taxes, maintenance, gifts, repairs), set aside a share every month in advance. The large bill then stops landing as one blow to the budget.
- In this app those are envelope budgets and savings goals.

### The gap between income and spending
- **Lifestyle creep**: spending quietly grows to match rising income and the savings rate falls. When income rises, deliberately lock part of the increase into savings.
- Separate **one-off** from **recurring** spending: a single large payment (tax, doctor, big purchase) must never be projected as monthly, or the whole picture is distorted.

### Timing large expenses
- Before a large purchase, check two things: whether the emergency fund drops below a safe level, and whether it collides with the month's other large charges (subscriptions, rent, taxes).
- Waiting and saving beats taking on expensive debt. "0%" instalment plans are rarely actually free — check the total overpayment.
`.trim(),
};
