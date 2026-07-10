-- §R5: контекст/розуміння для AI + зв'язування пар-переказів + опис підписок + відхилені кандидати.

-- Власне «розуміння» AI про операцію (короткий здогад «що це»). Раніше enrich повертав
-- note, але воно нікуди не зберігалось. Тепер тримаємо разом із user_note (моя нотатка).
ALTER TABLE transactions ADD COLUMN ai_note TEXT;

-- Зв'язок пари переказу (обидві сторони card↔card/card↔банка отримують спільний id =
-- id відпливної сторони). У списку показуємо пару ОДНИМ рядком, приховуючи вхідну сторону.
ALTER TABLE transactions ADD COLUMN transfer_pair_id TEXT;

-- Опис підписки для AI (я пишу, що це за платіж) — щоб AI точніше розумів списання.
ALTER TABLE planned_payments ADD COLUMN note TEXT;

-- Кандидати в підписки, які я закрив як «це НЕ підписка» — детект їх більше не пропонує.
CREATE TABLE IF NOT EXISTS planned_dismissed (
  merchant   TEXT PRIMARY KEY,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tx_transfer_pair ON transactions(transfer_pair_id);
