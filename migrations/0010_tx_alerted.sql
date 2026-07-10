-- §F2 крок 2 (частина 2): прапорець «за цю операцію вже надіслано TG-алерт», щоб
-- не дублювати пуш, якщо monobank повторно надішле вебхук або скан пройде вдруге.
ALTER TABLE transactions ADD COLUMN alerted INTEGER NOT NULL DEFAULT 0;
