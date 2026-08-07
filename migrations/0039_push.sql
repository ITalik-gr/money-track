-- §PUSH — browser notifications, so an alert arrives without Telegram.
--
-- Telegram pushes already exist and stay: they are better on a phone that has Telegram, and they
-- need no permission prompt. But they require a bound chat, which is a setup step most people will
-- not do — and the app's own notifications were therefore invisible unless someone opened it.
--
-- ⚠️ WHAT IS DELIBERATELY NOT STORED HERE: the subscription's `p256dh` and `auth` keys. Those exist
-- to ENCRYPT a payload, and we send no payload — the push is empty and the service worker fetches
-- the notification over the authenticated session (see `lib/messaging/webpush.ts`). So Google's and
-- Apple's push infrastructure never carries a single word about anyone's money, and this table
-- holds nothing that could decrypt one either. Not storing them is the feature.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  -- The push service's URL for this browser. Unique by construction — the browser mints one per
  -- installation and re-issuing it (a "subscription change") produces a different URL, so the
  -- primary key is exactly the identity we want.
  endpoint    TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  -- Last time the push service ACCEPTED a delivery. Not "last time we tried": the useful question
  -- is whether this browser is still reachable at all.
  last_ok_at  INTEGER,
  -- Consecutive failures that were not a definitive 404/410. A push service can be briefly
  -- unavailable, and dropping a subscription on one bad night would silently unsubscribe someone
  -- who did nothing wrong; a definitive "gone" deletes the row immediately instead.
  fail_count  INTEGER NOT NULL DEFAULT 0
);

-- Web push is tracked SEPARATELY from the Telegram push (`pushed_tg_at`), not with a shared flag.
-- With one column, whichever channel ran first would mark the notification as pushed and the other
-- would find nothing to send — the two channels would silently take turns.
ALTER TABLE notifications ADD COLUMN pushed_web_at INTEGER;
