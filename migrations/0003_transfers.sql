-- §9 (фідбек): перекази між своїми картками не є витратою/доходом.
-- Флаг проставляється детектом пар (протилежні рівні суми на різних рахунках
-- у вузькому вікні часу) або вручну на сторінці транзакції.
ALTER TABLE transactions ADD COLUMN is_transfer INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_tx_transfer ON transactions(is_transfer);
