// Domain types shared between the Worker API and the React frontend.
// Money is always INTEGER minor units (копійки); divide by 100 only for display.

export type AccountType =
  | "black"
  | "white"
  | "platinum"
  | "fop"
  | "jar"
  | "cash"
  | "manual_card"
  | "crypto";

export type TxSource = "mono" | "cash" | "manual";

// §R3: роль рахунку для логіки подушки. NULL/liquid → у ліквідну подушку; investment
// (крипта, брокер) → інвест-резерв, не подушка за замовчуванням.
export type AccountRole = "liquid" | "investment";

export interface Account {
  id: string;
  type: AccountType | null;
  title: string | null;
  currency_code: number | null;
  balance: number | null;
  credit_limit: number | null;
  is_manual: number;
  iban: string | null;
  is_active: number;
  updated_at: number | null;
  role: AccountRole | null;
  ai_note: string | null;
}

export interface Category {
  id: number;
  name: string;
  icon: string | null;
  color: string | null;
  parent_id: number | null;
  is_income: number;
  is_custom?: number;
  importance?: string | null; // §6: essential|discretionary|optional | null (=успадковує/бажана)
}

export interface EventGroup {
  id: number;
  name: string;
  kind: string;          // event | project | day | trip
  color: string | null;
  icon: string | null;
  note: string | null;
  is_active: number;
  created_at: number | null;
}

export interface Transaction {
  id: string;
  account_id: string;
  source: TxSource;
  time: number;
  amount: number;
  currency_code: number;                // валюта РАХУНКУ (§R2-CUR1) — amount у ній
  original_amount: number | null;       // сума у валюті операції, якщо ≠ валюти рахунку
  original_currency: number | null;     // код валюти операції (напр. 840 для $)
  mcc: number | null;
  category_id: number | null;
  real_category_id: number | null; // реальна категорія переказу/зняття (§F2 крок 2)
  merchant: string | null;
  comment: string | null;
  user_note: string | null;
  balance_after: number | null;
  cashback: number | null;
  hold: number;
  planned_id: number | null;
  receipt_id: number | null;
  raw_json: string | null;
  created_at: number | null;
}

export interface PlannedPayment {
  id: number;
  title: string;
  kind: "subscription" | "installment";
  total_amount: number | null;
  period_amount: number | null;
  period: "month" | "week";
  period_count?: number; // «кожні N періодів» (§SUB4); дефолт 1
  start_date: number;
  end_date: number | null;
  occurrences: number | null;
  category_id: number | null;
  account_id: string | null;
  currency_code?: number;
  note?: string | null; // мій опис підписки для AI (§R5)
  is_active: number;
}

export interface Budget {
  id: number;
  category_id: number | null;
  period: "month" | "week";
  amount: number;
  currency_code: number;
  rollover?: number; // §3: 1 = переносити невитрачений залишок минулого місяця
}

// §Хвіст C: глобальний лічильник витрат AI (акумульовано в app_state.ai_usage).
export interface AiUsageBucket {
  in: number; out: number; cache_read: number; cache_write: number; cost_usd: number; calls: number;
}
export interface AiUsageStats {
  today: AiUsageBucket & { key: string };
  month: AiUsageBucket & { key: string };
  total: AiUsageBucket;
  updated_at: number;
}

// §Хвіст: факт vs план по підписці — фактичні списання, лічильник, ознака подорожчання.
export interface PlannedActual {
  id: number;
  count: number;
  last_amount: number | null;
  last_time: number | null;
  currency_code: number | null;
  price_change_pct: number | null;
}

// Sum of own funds per currency, plus the credit-limit breakdown for the black card.
export interface NetWorthSummary {
  byCurrency: { currency_code: number; own: number }[];
  totalUAH: number; // converted at the cached mono rate
  credit: { accountId: string; limit: number; own: number; debt: number } | null;
}
