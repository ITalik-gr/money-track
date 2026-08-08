import type { KnowledgeDoc } from "./types.ts";

// Методологія Money Track — щоб AI пояснював цифри УЗГОДЖЕНО з тим, як їх рахує застосунок
// (UI = AI). Джерело істини самих розрахунків — worker/lib/stats.ts та advisor.ts.
export const appMethodology: KnowledgeDoc = {
  id: "app-methodology",
  title: "Як Money Track рахує цифри",
  summary: "Подушка/борг/інвест, burn і рівні категорій, runway, вагомість, спліт, повернення, факти, періоди.",
  titleEn: "How Money Track computes its numbers",
  summaryEn: "Cushion/debt/investments, burn and category levels, runway, importance, splits, refunds, facts, periods.",
  // 🔒 locked: цей документ описує КАНОН розрахунків. Якщо дозволити його переписати, AI почне
  // пояснювати цифри не так, як їх рахує код — рівно той розсинхрон «UI ≠ AI», який проєкт
  // тримає інваріантом. Оновлювати його можна ЛИШЕ тут, разом зі зміною самих розрахунків.
  locked: true,
  body: `
This section is about HOW the app arrives at its numbers. Explain things to the user in these same terms, so that what you say matches what they see on screen.

### Funds (three things that must never be mixed)
- **Liquid cushion** (liquid_cushion) — the user's real own money in liquid accounts (cash, cards, jars), EXCLUDING any credit limit. This is the number behind "how long do I last".
- **Card debt** (debt) — the used portion of a credit limit. It is debt, not "negative savings"; it is counted separately and does not reduce the cushion in the runway numerator.
- **Investment reserve** (investment) — accounts with role investment (crypto, brokerage). NOT part of the cushion and NOT part of runway. The last line of defence.
- Own funds (net) = cushion − debt. Multiple currencies are converted to hryvnia at the stored rates (app_state.rates); money is INTEGER minor units everywhere, divided by 100 only for display.

### Monthly burn and category "levels"
- **burn (monthly spending)** = the sum of every category's "monthly level", NOT "90-day spending ÷ 3". This keeps burn from being inflated by a one-off lump (a tax bill, a doctor) and lets it pick up a jump in a fixed cost immediately.
- **Category level** (categoryMonthlyLevels — the single source): for fixed costs (rent, a subscription — the last 2–3 complete months are stable) the level is the average of the most recent payments, so a price rise is caught at once (rent 8000→12500). For variable categories the level is the average over the window, which does not chase a random spike. Only COMPLETE months are counted.
- The same level is used everywhere — Patterns ("usual"), the Adviser and Budgets — which is why the number is identical on every screen.

### Runway
- runway_months = liquid cushion ÷ burn. That is "how many months the real money lasts at the current pace".

### Pace forecast
- The end-of-month forecast is "already spent + the historical remainder", not the naive "spent ÷ fraction of the month elapsed" (which inflates early in the month). Lumps (one or two large operations) are not extrapolated.

### Expense importance
- Every expense carries an importance level: **essential**, **discretionary**, **optional**. It is set on the category and can be overridden on an individual operation. When advising what to cut, go for optional first, then discretionary; never essential.

### One-off versus recurring
- An operation counts as recurring if it is tied to a plan or subscription, or if its merchant has spending in 3 or more distinct months. Everything else is one-off. Never describe a one-off expense as monthly.

### The facts layer (important for consistency)
- The user can state a fact about the world ("the metro fare went from 8 to 30 UAH", "I left my job").
- A **confirmed** fact carrying an amount adjustment (× multiplier or ± per month) changes the level of the matching category, and therefore burn and runway. This is the ONE place where a fact moves a number.
- An **unconfirmed** fact only shapes the narrative; it touches no number until the user applies it.
- So when a fact is confirmed, your figures already include it — do not add it again in your head.

### What counts as an expense at all
- An expense is a negative operation that is NOT a transfer between the user's own accounts and does not sit in the transfers-and-withdrawals bucket (category id 13). A transfer pair (card to jar) collapses into a single row and never reaches the statistics — otherwise "spending" would be inflated by the user's own movements of money.
- A cash withdrawal is counted by its REAL nature: if the user said what the withdrawn cash went on, the category comes from that, not from "withdrawal".
- Pending (hold) operations count: the bank only sends executed ones, and when a hold settles the same row is rewritten, so there is no double counting.

### A refund is NOT income
- An incoming amount that reverses an earlier purchase (a cancelled booking, a returned item) counts as a **negative expense in the same category**, not as income.
- Consequences: a category's month can come out negative if refunds exceeded spending, and a refund does NOT inflate "income". Never call a refund earnings, and never count it as income in the savings rate.
- A refund also does not increase the operation count — otherwise the average ticket would be understated.

### Splitting an operation across categories
- One purchase can be split across several categories (a supermarket receipt: groceries + household chemicals). All category analytics see the PARTS, not the whole sum in one category.
- But the bank charged one amount: when the subject is the individual operation (a large expense, a duplicate, a card limit), it is one sum, not its parts.

### Reimbursement ("they sent me money for this")
- An expense can be marked as partly someone else's: if the user paid for something shared and was paid back part of it, ONLY their share counts as spending (the operation's amount minus what was reimbursed).
- An incoming amount linked as a reimbursement is NOT income and is not a purchase refund — its effect already sits in the reduced expense. Do not call that money earnings and do not add it to income in your head.
- A reimbursement can also be recorded with no bank deposit at all (paid back in cash).

### Budgets (envelopes)
- A budget is a per-category limit for a period. States: ok / close to the limit / exceeded. It may carry over: what went unspent last period is added to this period's limit.
- The auto-budget proposes limits from history (category level minus a cut percentage) and **never cuts essential categories** — a trimmed budget for rent or groceries cannot be met, and it discredits the whole system. Hold to the same principle in your advice.

### Plans and subscriptions
- A planned payment has its OWN currency: a $5 subscription is $5, not 5 UAH. In totals, forecasts and "what is about to be charged", amounts are converted to hryvnia at the rate; in display, the plan's currency leads and the hryvnia equivalent is a caption.
- "Next charge" respects an "every N periods" cadence (a quarterly subscription does not come due monthly).
- A plan can be "dead": active for a long time with no actual charges visible. That is a cancellation candidate, not real spending.

### Financial health index
- A weighted 0–100 score from four signals: runway (cushion in months), savings rate, debt-to-income ratio, income stability. Reference points: a 3–6 month cushion, savings around 20% of income.
- The score is written daily, so there is a trend. When explaining a drop, name WHICH component fell rather than saying "the index went down".

### Goals and events
- A goal has an amount, a deadline and a "how much to set aside per month to make it" rate. If progress lags the clock, that is a risk and worth saying plainly.
- An event or trip is a group of expenses with its own budget, in several currencies, converted to hryvnia. Do not confuse an event budget with a category envelope budget.

### Net worth over time — the limits of accuracy
- The capital-composition chart is reconstructed backwards from current balances using operation history. Two limits to state honestly if they come up: (1) for periods with no rate history everything is recomputed at the current rate, so currency movement looks like money movement; (2) manual accounts with no recorded balance snapshots are shown flat going back.
- The last point in the series is the current, INCOMPLETE month. Do not compare it with complete months as an equal.

### Periods
- The accounting period is calendar or rolling (switchable in Statistics). The dashboard and Statistics show one and the same period. monthly_burn and avg_month are ALREADY monthly averages; spent_90d is a 90-day total — never call it monthly.

### One shared context
- The Adviser and the Chat take ONE financial snapshot (collectFinanceSnapshot), which is why the chat's figures match the Adviser's. Do not invent amounts outside the context you were given; if data is missing, call a tool or say so honestly.
`.trim(),
};
