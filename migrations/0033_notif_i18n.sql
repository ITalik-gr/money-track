-- Localizable notification feed (P3.3, PLATFORM.md §12.3).
--
-- Why: notifications.title/body were stored as a finished Ukrainian phrase, so switching the
-- UI language left the whole feed frozen in Ukrainian forever. The generators now also store
-- a template key + raw params (JSON), and the phrase is composed at READ time in the current
-- locale (shared/notif-i18n.ts). The old title/body columns STAY as a fallback — for rows
-- written before this migration and for the free-text `ai` kind (which has no template) — so
-- the existing feed does not go blank. Rendering rule: notif_key present -> render(key,params);
-- else show the stored title/body (COALESCE-style fallback).
--
-- Not a deploy blocker: unlike the reimbursement columns, these are read only by the feed path,
-- never by the canonical stats expressions, so remote D1 keeps working until this is applied
-- (the feed just renders the stored Ukrainian title until then).
ALTER TABLE notifications ADD COLUMN notif_key TEXT;      -- template key from shared/notif-i18n.ts; NULL for `ai`
ALTER TABLE notifications ADD COLUMN notif_params TEXT;   -- JSON params bag; NULL for `ai`
