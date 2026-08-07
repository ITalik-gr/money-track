// Response shapes of `/api/feedback` and the owner-only `/api/admin/feedback`.
// See `./analytics.ts` for why this file exists.

export type FeedbackKind = "bug" | "idea" | "other";

/** One report, as the owner reads it. Never leaves the admin screen. */
export interface FeedbackRow {
  id: number;
  /** NULL for a demo visitor — they have no account, and we do not invent an id for them. */
  user_id: string | null;
  email: string | null;
  kind: string;
  message: string;
  page: string | null;
  user_agent: string | null;
  created_at: number;
  handled_at: number | null;
}

/** Sandboxes started on one day, 'YYYY-MM-DD' in Europe/Kyiv. */
export interface DemoDay {
  day: string;
  sandboxes: number;
}

export interface AdminFeedback {
  feedback: FeedbackRow[];
  demo_days: DemoDay[];
}

/**
 * Where to write when the form is not enough.
 *
 * Served rather than hardcoded in the client: the owner's address lives ONLY in the deployment
 * secret `OWNER_EMAIL`, and this repository is public. A constant in the bundle would put a
 * personal address in git history, which is the one place it cannot be taken back out of.
 * `null` when the deployment has no owner address configured — then the UI simply omits the line.
 */
export interface FeedbackContact {
  email: string | null;
}
