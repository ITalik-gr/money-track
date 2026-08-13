// Response shapes of `/api/transactions/*` and everything hanging off one operation.
// Money is INTEGER minor units. See `./analytics.ts` for why this file exists.

/** A row of the operations feed. Joined display columns (`*_name`, `*_color`) come from the server. */
export interface TxRow {
  id: string;
  account_id: string;
  source: string;
  time: number;
  amount: number;
  currency_code: number;
  original_amount?: number | null;
  original_currency?: number | null;
  mcc: number | null;
  category_id: number | null;
  merchant: string | null;
  comment: string | null;
  user_note: string | null;
  hold: number;
  category_name: string | null;
  category_color: string | null;
  category_icon?: string | null;
  account_title: string | null;
  is_transfer?: number;
  real_category_id?: number | null;   // реальна суть зняття/переказу → лишає операцію витратою
  transfer_pair_id?: string | null;   // пара-переказ між своїми: подача нейтральна (`lib/transfer.ts`)
  pair_account_title?: string | null; // рахунок другої сторони пари → маршрут «звідки → куди»
  planned_id?: number | null;   // прив'язано до підписки → бейдж «підписка» (§R6)
  event_id?: number | null;
  event_name?: string | null;
  event_color?: string | null;
  importance?: string | null;   // §6: override вагомості операції (essential|discretionary|optional)
  reimbursed?: number | null;   // §COMPENSATION: скільки з цієї витрати компенсували (мінор)
}

export interface ReceiptItemRow { id: number; name: string | null; qty: number | null; price: number | null }
export interface ReceiptRow {
  id: number; image_key: string | null; store: string | null; total: number | null;
  currency_code: number | null; purchased_at: number | null; items: ReceiptItemRow[];
}
export interface TagRow { id: number; name: string; color: string | null }

export interface TxDetail extends TxRow {
  mcc: number | null;
  real_category_id: number | null;      // реальна категорія переказу/зняття (§F2 крок 2)
  real_category_name: string | null;
  real_category_color: string | null;
  cashback: number | null;
  comment: string | null;
  balance_after: number | null;
  receipt_id: number | null;
  raw_json: string | null;
  category_icon: string | null;
  account_type: string | null;
  is_transfer?: number;
  ai_enriched?: number;
  name_locked?: number;             // §R7: ручну назву зафіксовано — AI не перезаписує
  reimbursed?: number | null;       // §COMPENSATION: скільки з цієї витрати компенсували
  reimburses_id?: string | null;    // §COMPENSATION: ця операція — компенсація за витрату X
  ai_note?: string | null;          // розуміння AI «що це» (§R5)
  planned_id?: number | null;       // зв'язок із підпискою
  planned_title?: string | null;    // назва підписки, якщо прив'язано
  event_id?: number | null;
  event_name?: string | null;
  receipt: ReceiptRow | null;
  tags: TagRow[];
}

/** One-tap repeat of a cash operation the user enters often (`GET /transactions/frequent`). */
export interface FrequentTx {
  merchant: string;
  category_id: number | null;
  currency_code: number;
  n: number;
  /** Median of the recent amounts, POSITIVE minor units. */
  amount: number;
}

// §SPLIT: частина розділеної транзакції (копійки, знак як у tx). Порожній список = не розділено.
export interface TxSplit { id: number; category_id: number; amount: number; category_name: string | null; category_color: string | null }

// §COMPENSATION: стан «мені скинули за це» + кандидати на привʼязку (надходження поруч у часі).
// `label` збирає сервер (мерчант → коментар → нотатка → рахунок): у вхідних P2P мерчант часто
// порожній, і рядок лишався б без назви.
// `available` — скільки з надходження ще не роздано по витратах; `allocated_here` — скільки з
// нього вже пішло саме на цю витрату. Одне надходження може покривати кілька витрат.
export interface ReimbursementTx {
  id: string; label: string; account_title: string | null;
  amount: number; currency_code: number; time: number;
  available: number; allocated_here: number;
}
export interface Reimbursement {
  tx: { id: string; amount: number; currency_code: number; reimbursed: number };
  linked: ReimbursementTx[];
  candidates: ReimbursementTx[];
}
// Зворотний бік: куди пішло це надходження і скільки з нього ще вільно.
export interface ReimbursementUsage {
  used: { id: string; amount: number; label: string; time: number; expense_amount: number }[];
  allocated: number; available: number; currency_code?: number;
}

export interface TransferReviewRow {
  id: string; merchant: string | null; comment: string | null; amount: number; currency_code: number; time: number;
  real_category_id: number | null; note: string | null; needs_attention: boolean;
}

/**
 * `GET /transactions/:id/similar` — operations that look like the same kind of thing, and would
 * CHANGE if the current one's category / transfer flag were applied to them.
 *
 * `suggested` is the server's opinion about what to pre-tick: a row with no category is a gap,
 * a row with a different one is somebody's decision. Both are listed; only the gap is ticked.
 */
export interface SimilarTx {
  id: string;
  time: number;
  amount: number;
  currency_code: number;
  merchant: string | null;
  category_id: number | null;
  category_name: string | null;
  is_transfer: number;
  suggested: number;
}
export interface SimilarTxList { token: string | null; items: SimilarTx[] }

/**
 * `GET /transactions/:id/why` — what the deterministic chain says about this operation TODAY.
 *
 * Not a record of what happened when the row arrived (nothing stores that), and it says so: this
 * is the app re-asking its own rules and reporting the answer, which is the more useful question
 * anyway — it reveals when the stored category and the rules DISAGREE.
 */
export interface CategoryWhy {
  /** Which step answered: a learned alias, a subscription, an MCC rule, a text rule — or nothing. */
  source: "alias_desc" | "alias_mcc" | "subscription" | "rule_mcc" | "rule_text" | null;
  /** The matched thing in the user's own words: the alias key, the MCC, the rule's pattern. */
  detail: string | null;
  /** The category those rules point at, and its name for display. */
  category_id: number | null;
  category_name: string | null;
  /** Whether that matches what the operation is actually filed under. */
  agrees: boolean;
  /** True when the model wrote this row's category (`ai_enriched`), with its note if there is one. */
  ai_enriched: boolean;
  ai_note: string | null;
}
