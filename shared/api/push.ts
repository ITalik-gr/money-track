// Response shapes of `/api/push/*`. See `./analytics.ts` for why this file exists.

export interface PushStatus {
  /** Whether this deployment has VAPID keys at all. False → the UI says so instead of offering
   *  a permission prompt that would fail after the user has already said yes. */
  configured: boolean;
  /** Public VAPID key, base64url of the uncompressed P-256 point — straight into
   *  `applicationServerKey`. Null when not configured. */
  key: string | null;
  /** How many browsers this account has subscribed. */
  subscriptions: number;
}

/** What a manual test push actually did, per browser. */
export interface PushSendResult {
  sent: number;
  /** Subscriptions the push service reported as gone (404/410); removed. */
  dropped: number;
  failed: number;
}
