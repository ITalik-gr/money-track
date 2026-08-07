// Response shapes of the platform surface: `/api/settings/*`, `/api/notifications/*`,
// `/api/events/*`, `/api/search`, `/api/admin/*`, `/api/credentials`, `/api/setup/*`.
// See `./analytics.ts` for why this file exists.
import type { EventGroup } from "../types.ts";
import type { NotifTemplateKey } from "../notif-i18n.ts";

export interface EventWithAgg extends EventGroup {
  tx_count: number;
  spent: number;
  income: number;
}

// Збережений фільтр Транзакцій: `query` — той самий рядок, що в URL сторінки.
export interface SavedFilter { id: string; name: string; query: string }

// Глобальний пошук (командна панель Ctrl-K). Сторінки/дії статичні на клієнті — тут лише дані.
export interface SearchResults {
  merchants: { name: string; n: number; spent: number }[];
  categories: { id: number; name: string; color: string | null; parent_name: string | null }[];
  transactions: { id: string; time: number; amount: number; currency_code: number; merchant: string | null; category_name: string | null }[];
}

// Центр сповіщень: стрічка того, що система «хоче сказати» (репорти/дедлайни/аномалії/…).
export type NotifKind =
  | "report" | "deadline" | "anomaly" | "budget" | "price_up" | "liquidity"
  | "big_tx" | "duplicate" | "health_drop" | "goal_risk" | "dead_sub" | "win" | "todo" | "ai";
export interface Notification {
  id: number; kind: NotifKind; title: string; body: string | null;
  // Template key + JSON params for locale-aware re-rendering of the feed (P3.3). NULL for the
  // free-text `ai` kind and legacy rows — those render the stored title/body verbatim.
  notif_key: NotifTemplateKey | null; notif_params: string | null;
  severity: "info" | "warn" | "urgent";
  entity_type: string | null; entity_id: string | null;
  created_at: number; read_at: number | null;
}
export interface NotificationFeed { items: Notification[]; unread: number }
export type NotifPrefs = Record<NotifKind, boolean>;

/** Owner-only directory row (admin UI, D2). Carries identity only — never anything financial. */
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  status: "invited" | "active" | "disabled";
  is_owner: boolean;
  created_at: number;
  last_login_at: number | null;
  /** Last authenticated API call. Answers "is this in use?", which `last_login_at` cannot —
   *  a 30-day session lets someone use the app daily without ever logging in again. */
  last_seen_at: number | null;
  // `null` = never reported yet (directory migration 0004 + one daily cron pass). Rendering a
  // null as 0 would claim the account is empty, which is a different — and possibly false — fact.
  tx_count: number | null;
  accounts_count: number | null;
  has_mono_key: boolean | null;
  has_ai_key: boolean | null;
  stats_at: number | null;
}

/** `set` — the user stored their OWN key. `available` — a usable key exists at all (the owner's
 *  comes from deployment secrets, so `set` is false while AI works fine). Gate UI on `available`. */
export interface CredentialStatus {
  name: "mono_token" | "anthropic_api_key";
  set: boolean;
  available: boolean;
  updated_at: number | null;
  last_ok_at: number | null;
}

export interface SetupStatus {
  webhookRegistered: boolean;
  accounts: number;
  transactions: number;
  /** Cached foreign-currency rates. 0 = the rates step has never run. */
  rates: number;
  /** The "about me" text the adviser reads. Empty until the user writes one. */
  profileSet: boolean;
  backfill: { progress: number; total: number; done: boolean } | null;
}

// ROADMAP L5: one planned merchant rename («Сільпо» → `Silpo`), previewed before it is applied.
export interface TranslitFix {
  from: string;
  to: string;
  n: number;
  source: "sibling" | "description";
}
