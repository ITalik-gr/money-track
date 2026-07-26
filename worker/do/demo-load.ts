// Demo dataset loader (P4.2, PLATFORM.md §11).
//
// Turns the committed snapshot (`worker/demo/dataset.json`, built by scripts/seed-demo.mjs) into
// ordered INSERT statements for a fresh demo Durable Object. Two responsibilities:
//   1. TIME REBASE — the snapshot stores absolute timestamps anchored at `meta.anchor`; every
//      field listed in `meta.timeFields` is shifted by (nowAtLoad − anchor) so the newest
//      transaction is always ~today and the 6-month sparklines/trends never go empty. This is the
//      contract documented at the top of the generator.
//   2. FK-SAFE ORDER — the DO enforces foreign keys, so parents are inserted before children
//      (accounts → plans → receipts → transactions → splits/reimbursements → …). Categories are
//      already seeded by the migrations, so the dataset never carries them.
//
// Pure and side-effect free: it returns {sql, binds}[] and the DO runs them in one batch. Keeping
// it a pure builder means it can be unit-tested against the shim without a live object.
import demoDatasetJson from "../demo/dataset.json";

type Row = Record<string, unknown>;
interface DemoDataset {
  meta: { anchor: number; timeFields: Record<string, string[]> };
  [table: string]: unknown;
}
const dataset = demoDatasetJson as unknown as DemoDataset;

export interface DemoStatement { sql: string; binds: (string | number | null)[] }

// Explicit column lists — the INSERT order of VALUES must match, and being explicit keeps the
// loader honest if a table gains a column later (the extra column just defaults).
const COLUMNS: Record<string, string[]> = {
  accounts: ["id", "type", "title", "currency_code", "balance", "credit_limit", "is_manual", "is_active", "role", "ai_note", "provider", "statement_day", "payment_day", "min_payment", "updated_at"],
  planned_payments: ["id", "title", "kind", "total_amount", "period_amount", "period", "period_count", "start_date", "end_date", "occurrences", "category_id", "account_id", "currency_code", "is_active", "note"],
  savings_goals: ["id", "name", "target_amount", "current_amount", "account_id", "deadline", "color", "note", "is_active", "created_at"],
  event_groups: ["id", "name", "kind", "color", "icon", "note", "is_active", "created_at", "budget"],
  receipts: ["id", "transaction_id", "image_key", "store", "purchased_at", "total", "currency_code", "ai_json", "created_at"],
  transactions: ["id", "account_id", "source", "time", "amount", "currency_code", "mcc", "category_id", "merchant", "comment", "user_note", "balance_after", "cashback", "hold", "planned_id", "receipt_id", "is_transfer", "ai_enriched", "event_id", "real_category_id", "original_amount", "original_currency", "ai_note", "transfer_pair_id", "importance", "name_locked", "reimbursed", "reimburses_total", "created_at", "raw_json"],
  receipt_items: ["id", "receipt_id", "name", "qty", "price", "category_id"],
  tx_splits: ["id", "tx_id", "category_id", "amount", "created_at"],
  tx_reimbursements: ["id", "expense_id", "source_tx_id", "amount", "created_at"],
  budgets: ["id", "category_id", "period", "amount", "currency_code"],
  health_history: ["day", "score", "ts"],
  // Pre-baked AI surfaces (P4.3) so the demo looks full at $0. Standalone tables, no FK to user data.
  notifications: ["id", "kind", "title", "body", "notif_key", "notif_params", "severity", "entity_type", "entity_id", "dedup_key", "created_at", "read_at", "pushed_tg_at"],
  ai_reports: ["id", "period_type", "period_from", "period_to", "created_at", "model", "cost_usd", "summary", "data_json"],
  app_state: ["key", "value"],
};

// Parents before children so FK checks pass without deferral.
const ORDER = [
  "accounts", "planned_payments", "savings_goals", "event_groups", "receipts",
  "transactions", "receipt_items", "tx_splits", "tx_reimbursements", "budgets",
  "health_history", "notifications", "ai_reports", "app_state",
];

function toBind(v: unknown): string | number | null {
  if (v == null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * Build the ordered INSERTs for a fresh demo object. `nowSec` is load time; every timestamp is
 * shifted so the snapshot reads as "recorded up to now". INSERT OR REPLACE keeps it idempotent
 * if a load is ever retried.
 */
export function buildDemoStatements(nowSec: number): DemoStatement[] {
  const shift = nowSec - dataset.meta.anchor;
  const out: DemoStatement[] = [];

  for (const table of ORDER) {
    const rows = dataset[table] as Row[] | undefined;
    if (!rows || !rows.length) continue;
    const cols = COLUMNS[table];
    const timeCols = new Set(dataset.meta.timeFields[table] ?? []);
    const placeholders = cols.map(() => "?").join(", ");
    const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;

    for (const row of rows) {
      const shifted: Row = { ...row };
      for (const tc of timeCols) if (typeof shifted[tc] === "number") shifted[tc] = (shifted[tc] as number) + shift;
      // `health_history.day` is the string form of its `ts`; after shifting ts it must be recomputed.
      if (table === "health_history" && typeof shifted.ts === "number") {
        shifted.day = new Date((shifted.ts as number) * 1000).toISOString().slice(0, 10);
      }
      out.push({ sql, binds: cols.map((c) => toBind(shifted[c])) });
    }
  }
  return out;
}
